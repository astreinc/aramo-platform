import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { GEO_IP_PORT, type GeoIpPort, PersonalRiskService, type TenantDto, geoEvidenceOf, personalSignupMode, safeGeoLookup } from '@aramo/identity';
import { EsignSenderRepository } from '@aramo/sign';
import {
  AllowanceService,
  ESIGN_ENVELOPE_ALLOWANCE,
  FreePersonalSubscriptionService,
  type PersonalSignupMode,
} from '@aramo/subscription';
import { PDFDict, PDFName, PDFRawStream, PDFDocument, decodePDFRawStream } from 'pdf-lib';
import type { Request } from 'express';

import { PersonalLegalStatusService, legalAcceptanceRequired } from '../legal/personal-legal-status.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1-LOCKED §4 / §6 — the Personal
// sending gate on the sender console. It runs ONLY for a PERSONAL tenant; Business
// tenants and every ATS / Sign API path never reach it.
//
//   mode off            → nothing here runs: the caller keeps today's refusal
//                         (personal_sending_not_enabled), byte for byte.
//   FREE subscription   → opened lazily for an ACTIVE (bound) PERSONAL tenant;
//                         sending authority stays tenant_owner + the `sign`
//                         entitlement + a subscription in a sending state.
//   risk gate (§6.3/6.6)→ identity's assertPersonalSendAllowed with the network
//                         country of the request and its GeoLite2 evidence
//                         (offline; a failed lookup is UNKNOWN): review,
//                         restriction and step-up without phone assurance are
//                         refused. Sending from outside the allowed countries or
//                         from an UNKNOWN location is a risk signal (Architect
//                         ruling 2026-10-21; PO "allow; review only if new"):
//                         allowed and audited, except for an account younger than
//                         7 days or with open risk signals — then flagged for
//                         review and refused (personal_review_pending). IP
//                         location alone never refuses with
//                         personal_location_not_supported.
//   young account §6.2  → the first 30 days or the first 10 sends: impersonation /
//                         scam wording, links in the PDF and a first send to
//                         several recipients raise review or step-up.
// Guest signers are never evaluated: this gates the SENDER only.

export const YOUNG_ACCOUNT_DAYS = 30;
export const YOUNG_ACCOUNT_SENDS = 10;

export type PersonalGateReason =
  | 'personal_review_pending'
  | 'personal_restricted'
  | 'phone_verification_required'
  | 'personal_location_not_supported';

const GATE_MESSAGES: Record<PersonalGateReason, string> = {
  personal_review_pending: 'Your account is being reviewed. Sending is paused until the review is complete.',
  personal_restricted: 'Sending is paused on this account.',
  phone_verification_required: 'Verify your mobile number to send.',
  personal_location_not_supported: 'Aramo Sign Personal is currently available in the United States and India.',
};

export function personalGateError(reason: PersonalGateReason, requestId: string): AramoError {
  return new AramoError('INSUFFICIENT_PERMISSIONS', GATE_MESSAGES[reason], 403, { requestId, details: { reason } });
}

/**
 * The client address as nginx saw it: exactly one proxy hop (the platform's
 * TRUST_PROXY_HOPS = 1 rule) — the right-most X-Forwarded-For entry, else the
 * socket peer. Computed here so sign-service's global request handling is unchanged.
 */
export function clientIp(req: Pick<Request, 'headers' | 'socket'>): string | null {
  const xff = req.headers['x-forwarded-for'];
  const raw = Array.isArray(xff) ? xff.join(',') : xff;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parts = raw.split(',').map((p) => p.trim()).filter((p) => p !== '');
    const last = parts[parts.length - 1];
    if (last !== undefined) return last;
  }
  return req.socket?.remoteAddress ?? null;
}

// ── §6.2 young-account send checks ────────────────────────────────────────────

// Scam / lure wording in the title, document titles or sender name (case-insensitive).
export const SCAM_WORDING: readonly RegExp[] = [
  /\bverify your (account|identity|password|email)\b/i,
  /\b(account|mailbox|card) (is )?(suspended|locked|blocked|deactivated|on hold)\b/i,
  /\b(reset|confirm|update|validate) your (password|login|credentials|bank|payment|card)\b/i,
  /\bpasswords?\b/i,
  /\bgift ?cards?\b/i,
  /\b(wire|bank) transfer\b/i,
  /\b(bitcoin|crypto(currency)?|usdt)\b/i,
  /\b(lottery|jackpot|prize|winnings?)\b/i,
  /\b(urgent|immediate) (action|payment|response|attention)\b/i,
  /\b(tax refund|social security|aadhaar|pan card|kyc)\b/i,
  /\b(otp|one[- ]time (code|password))\b/i,
  /\binvoice (is )?(overdue|past due)\b/i,
];

// Impersonation in the SENDER NAME: an institution, a brand or a help desk.
export const IMPERSONATION_NAMES: readonly RegExp[] = [
  /\b(support|security|help ?desk|service desk|admin(istrator)?|billing|payroll|it department|compliance)\b/i,
  /\b(aramo|paypal|amazon|microsoft|apple|google|docusign|netflix|fedex|dhl|ups|usps)\b/i,
  /\b(bank|irs|police|government|income tax|customs)\b/i,
];

/** Extra wording from configuration (SIGN_PERSONAL_SEND_WORDING, comma-separated phrases). */
export function configuredWording(env: NodeJS.ProcessEnv = process.env): RegExp[] {
  const raw = env['SIGN_PERSONAL_SEND_WORDING'] ?? '';
  return raw
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && w.length <= 80)
    .map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
}

export function hasScamWording(texts: readonly string[], senderName: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  const lures = [...SCAM_WORDING, ...configuredWording(env)];
  const all = [...texts, ...(senderName !== null ? [senderName] : [])];
  if (all.some((t) => lures.some((re) => re.test(t)))) return true;
  return senderName !== null && IMPERSONATION_NAMES.some((re) => re.test(senderName));
}

const LINK_RE = /(https?:\/\/|www\.)[a-z0-9-]/i;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;

/** A URI action anywhere in the dictionary or its direct (nested) dictionaries. */
function dictHasUri(dict: PDFDict, depth: number): boolean {
  if (dict.has(PDFName.of('URI')) || dict.get(PDFName.of('S'))?.toString() === '/URI') return true;
  if (depth >= 4) return false;
  return dict.values().some((v) => v instanceof PDFDict && dictHasUri(v, depth + 1));
}

/** A content stream's text: the raw bytes plus its hex-string operands decoded (simple fonts). */
function streamText(decoded: Uint8Array): string {
  const raw = Buffer.from(decoded).toString('latin1');
  const hex = raw.match(/<[0-9A-Fa-f\s]{2,}>/g) ?? [];
  const fromHex = hex.map((h) => Buffer.from(h.slice(1, -1).replace(/\s+/g, ''), 'hex').toString('latin1')).join('');
  return `${raw}\n${fromHex}`;
}

/**
 * Links in a PDF: a URI action / link annotation anywhere, or an http(s) / www
 * address in any decodable stream (page text drawn with standard encodings).
 * QR codes are images and are NOT detected here.
 */
export async function pdfHasLinks(bytes: Uint8Array): Promise<boolean> {
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return false;
  }
  for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFRawStream ? obj.dict : obj instanceof PDFDict ? obj : null;
    if (dict !== null && dictHasUri(dict, 0)) return true;
    if (obj instanceof PDFRawStream) {
      if (obj.contents.byteLength > MAX_STREAM_BYTES) continue;
      let decoded: Uint8Array;
      try {
        decoded = decodePDFRawStream(obj).decode();
      } catch {
        continue;
      }
      if (decoded.byteLength > MAX_STREAM_BYTES * 4) continue;
      if (LINK_RE.test(streamText(decoded))) return true;
    }
  }
  return false;
}

export interface YoungSendInput {
  subject: string;
  document_titles: readonly string[];
  sender_name: string | null;
  recipient_count: number;
  pdfs: () => Promise<readonly Uint8Array[]>;
}

export type YoungSendFinding = 'young_account_wording' | 'young_account_pdf_links' | 'young_account_first_send_several_recipients';

@Injectable()
export class PersonalSendGate {
  private readonly log = new Logger(PersonalSendGate.name);

  constructor(
    private readonly free: FreePersonalSubscriptionService,
    private readonly allowance: AllowanceService,
    private readonly risk: PersonalRiskService,
    @Inject(GEO_IP_PORT) private readonly geo: GeoIpPort,
    private readonly senderRepo: EsignSenderRepository,
    // Personal legal documents: a current APPROVED version not yet accepted by
    // this sender blocks sending until accepted in the workspace.
    @Optional() private readonly legal?: PersonalLegalStatusService,
  ) {}

  /** Refuse `legal_acceptance_required` while the sender owes an acceptance of a current document. */
  async assertLegalAccepted(tenant: Pick<TenantDto, 'id' | 'kind'>, user_id: string, requestId: string): Promise<void> {
    if (this.legal === undefined) return;
    if ((await this.legal.pendingFor(tenant, user_id)).length > 0) throw legalAcceptanceRequired(requestId);
  }

  mode(): PersonalSignupMode {
    return personalSignupMode();
  }

  /** Personal authoring is open only while the mode is not off and the tenant is bound (ACTIVE). */
  authoringOpen(tenant: Pick<TenantDto, 'kind' | 'status'>): boolean {
    return tenant.kind === 'PERSONAL' && tenant.status === 'ACTIVE' && this.mode() !== 'off';
  }

  /** Lazily open the FREE subscription (account read and before send). Never calls a billing provider. */
  async ensureFreeSubscription(tenant: Pick<TenantDto, 'id' | 'kind' | 'status'>): Promise<void> {
    const r = await this.free.ensure({ tenant_id: tenant.id, tenant_kind: tenant.kind, tenant_status: tenant.status, mode: this.mode() });
    if (r.ok && r.opened) this.log.log(`FREE subscription opened for personal tenant ${tenant.id}`);
  }

  /** §6.3 / §6.6 — the identity risk gate with the request's network country + its evidence. */
  async assertRiskGate(tenant_id: string, ip: string | null, requestId: string, now: Date = new Date()): Promise<void> {
    // Never throws: no IP, no database or a lookup error is UNKNOWN (country null).
    const geo = await safeGeoLookup(this.geo, ip, now);
    const verdict = await this.risk.assertPersonalSendAllowed(tenant_id, { ip_country: geo.country, now, geo: geoEvidenceOf(geo) });
    if (!verdict.ok) throw personalGateError(verdict.reason, requestId);
  }

  /** §6.2 — young-account send checks; findings raise review or step-up (identity state). */
  async youngAccountFindings(tenant: Pick<TenantDto, 'id' | 'created_at'>, input: YoungSendInput, now: Date = new Date()): Promise<YoungSendFinding[]> {
    const counts = await this.senderRepo.countByStatus(tenant.id);
    const priorSends = Object.entries(counts).reduce((n, [status, c]) => (status === 'DRAFT' ? n : n + c), 0);
    const ageMs = now.getTime() - new Date(tenant.created_at).getTime();
    const young = !(ageMs >= YOUNG_ACCOUNT_DAYS * 86_400_000) || priorSends < YOUNG_ACCOUNT_SENDS;
    if (!young) return [];
    const findings: YoungSendFinding[] = [];
    if (hasScamWording([input.subject, ...input.document_titles], input.sender_name)) findings.push('young_account_wording');
    if (priorSends === 0 && input.recipient_count > 1) findings.push('young_account_first_send_several_recipients');
    for (const bytes of await input.pdfs()) {
      if (await pdfHasLinks(bytes)) {
        findings.push('young_account_pdf_links');
        break;
      }
    }
    return findings;
  }

  /**
   * The full send-time gate for a PERSONAL sender. Allowance first: a send the
   * allowance would refuse is refused there (no checks recorded against it).
   */
  async assertMaySend(tenant: TenantDto, ip: string | null, input: YoungSendInput, requestId: string, now: Date = new Date()): Promise<void> {
    await this.ensureFreeSubscription(tenant);
    await this.assertRiskGate(tenant.id, ip, requestId, now);
    const status = await this.allowance.getStatus(tenant.id, ESIGN_ENVELOPE_ALLOWANCE, now);
    if (!status.subscribed || status.remaining === 0 || status.daily?.remaining === 0) return; // guardSend refuses it
    const findings = await this.youngAccountFindings(tenant, input, now);
    if (findings.length === 0) return;
    const reason = findings.join(',');
    if (findings.includes('young_account_wording')) {
      await this.risk.flagForReview(tenant.id, reason, now);
      throw personalGateError('personal_review_pending', requestId);
    }
    // Step-up already satisfied: a verified phone, or — while SMS was unavailable —
    // an operator's review lifted the phone step (step_up_cleared_by 'review'; the
    // phone stays unverified). A lifted step is not re-asked for the same checks.
    const state = await this.risk.riskStateOf(tenant.id);
    if (state?.phone_verified_at != null || state?.step_up_cleared_by === 'review') return;
    // Without SMS the step-up routes the account to review (identity decides).
    const after = await this.risk.requireStepUp(tenant.id, reason, now);
    throw personalGateError(after.state === 'review' || after.review_pending ? 'personal_review_pending' : 'phone_verification_required', requestId);
  }
}
