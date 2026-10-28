import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import {
  PersonalRiskService,
  PrivacyRequestService,
  PrivacySubjectService,
  isPlausibleEmail,
  isPrivacyRequestType,
  normalizePrivacyEmail,
  normalizePrivacyReference,
  privacyDeletionExecutionEnabled,
  privacyEmailKeyAvailable,
  type PrivacyActor,
  type PrivacyRequestRecord,
  type PrivacyRequestType,
  type PrivacyRequestView,
  type PrivacySubjectContext,
  type PrivacySubjectKind,
} from '@aramo/identity';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import { SignPrivacyRepository, signBaseUrl } from '@aramo/sign';

import { ConvenienceDataPurgeService } from '../push/convenience-data-purge.service.js';
import { SavedDataPurgeService } from '../me/signature/saved-data-purge.service.js';

import { SIGN_BUSINESS_RETAINED_CATEGORY, SIGN_RETAINED_CATEGORIES, SignPrivacyExecutionService } from './sign-privacy-execution.service.js';

// Aramo-Sign-Mobile-Amendment-M-A7 §3 — Aramo Sign's privacy requests (the first
// consumer of the platform capability in @aramo/identity).
//
// IN-APP (signed in, any account type; identity validated by the session):
//   create   RECEIVED → IDENTITY_VALIDATED → DATA_INVENTORY (counts only), then
//            Personal owner  DELETION: the existing account close runs first (risk
//                            state closed, convenience data purged — the step the old
//                            "Close account" performed); with execution ENABLED the
//                            request moves to EXECUTING and is executed now.
//            Business member: REFERRED_TO_ORGANIZATION (the organization decides about
//                            its documents; Aramo stays responsible); with execution
//                            ENABLED Aramo then executes the member's own part.
//            Other types (ACCESS, EXPORT, CORRECTION) wait for the privacy team.
//   One open request per (user, type): a repeat answers the open one.
//
// WEB (no sign-in): start → a one-time link to the email (token in the URL fragment)
//   → verify (token in the POST body) → the request is RECEIVED → IDENTITY_VALIDATED →
//   DATA_INVENTORY and waits for the privacy team (a web request is never executed
//   without an operator). The start answers the same whatever the email (no account
//   enumeration) and is budgeted per client address and per email.
// STATUS by reference: in-app for the requester's own requests; on the web with the
//   reference AND the email (keyed-hash match) — a mismatch answers the same 404.

const SUBJECT: (user_id: string) => PrivacyActor = (user_id) => ({ actor_type: 'SUBJECT', actor_id: user_id });
const SYSTEM: PrivacyActor = { actor_type: 'SYSTEM', actor_id: null };

export const DELETE_CONFIRMATION = 'DELETE';
export const PRIVACY_WEB_IP_BUDGET_MAX = 10;
export const PRIVACY_WEB_BUDGET_WINDOW_MS = 10 * 60 * 1000;
export const PRIVACY_WEB_EMAIL_BUDGET_MAX = 3;
export const PRIVACY_WEB_EMAIL_BUDGET_WINDOW_MS = 60 * 60 * 1000;
export const PRIVACY_DELETE_PAGE_PATH = '/delete-account';

export interface SignPrivacyRequestView extends PrivacyRequestView {
  retained: ReadonlyArray<{ key: string; label: string; why: string }>;
  organization_decides: string | null;
  privacy_contact: string;
}

export const PRIVACY_CONTACT = 'privacy@aramo.ai';

@Injectable()
export class PrivacyWebBudget {
  private readonly windows = new Map<string, { start: number; count: number }>();
  allow(key: string, now: number, max = PRIVACY_WEB_IP_BUDGET_MAX, windowMs = PRIVACY_WEB_BUDGET_WINDOW_MS): boolean {
    const w = this.windows.get(key);
    if (w === undefined || now - w.start >= windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= max) return false;
    w.count += 1;
    return true;
  }
  reset(): void {
    this.windows.clear();
  }
}

function notFound(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'No privacy request matches', 404, { requestId, details: { reason: 'privacy_request_not_found' } });
}

function invalidLink(requestId: string): AramoError {
  return new AramoError('NOT_FOUND', 'This link can’t be used. Start a new request.', 404, { requestId, details: { reason: 'privacy_link_invalid' } });
}

function bad(requestId: string, message: string, reason: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason } });
}

@Injectable()
export class SignPrivacyRequestService {
  private readonly log = new Logger('SignPrivacyRequests');

  constructor(
    private readonly requests: PrivacyRequestService,
    private readonly subjects: PrivacySubjectService,
    private readonly risk: PersonalRiskService,
    private readonly sign: SignPrivacyRepository,
    private readonly execution: SignPrivacyExecutionService,
    private readonly budget: PrivacyWebBudget,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
    @Optional() private readonly purge?: ConvenienceDataPurgeService,
    @Optional() private readonly savedData?: SavedDataPurgeService,
  ) {}

  view(r: PrivacyRequestRecord): SignPrivacyRequestView {
    const business = r.subject_kind === 'BUSINESS_MEMBER' || r.referred_tenant_id !== null;
    return {
      ...this.requests.view(r),
      retained: r.request_type === 'DELETION' ? (business ? [...SIGN_RETAINED_CATEGORIES, SIGN_BUSINESS_RETAINED_CATEGORY] : SIGN_RETAINED_CATEGORIES) : [],
      organization_decides: business
        ? 'Your organization decides about documents it sent or that you received in your role. Aramo referred your request to it and remains responsible: if the organization does not act, contact privacy@aramo.ai.'
        : null,
      privacy_contact: PRIVACY_CONTACT,
    };
  }

  // ── In-app ──

  async listMine(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>): Promise<{ items: SignPrivacyRequestView[] }> {
    return { items: (await this.requests.listForSubject(auth.sub, auth.tenant_id)).map((r) => this.view(r)) };
  }

  async getMine(auth: Pick<AuthContextType, 'tenant_id' | 'sub'>, reference: string, requestId: string): Promise<SignPrivacyRequestView> {
    const ref = normalizePrivacyReference(reference);
    if (ref === null) throw notFound(requestId);
    const r = await this.requests.findByReference(ref);
    // Tenant + subject isolation: only the requester's own request in this tenant.
    if (r === null || r.subject_user_id !== auth.sub || r.subject_tenant_id !== auth.tenant_id) throw notFound(requestId);
    return this.view(r);
  }

  async createInApp(
    auth: Pick<AuthContextType, 'tenant_id' | 'sub'>,
    body: { request_type?: unknown; confirm?: unknown } | undefined,
    requestId: string,
    now: Date = new Date(),
  ): Promise<{ created: boolean; request: SignPrivacyRequestView }> {
    const type = body?.request_type ?? 'DELETION';
    if (!isPrivacyRequestType(type)) throw bad(requestId, 'request_type must be DELETION, ACCESS, EXPORT or CORRECTION', 'invalid_request_type');
    if (type === 'DELETION' && body?.confirm !== DELETE_CONFIRMATION) {
      throw bad(requestId, 'Type DELETE to confirm the deletion request', 'deletion_confirmation_required');
    }
    const ctx = await this.subjects.context(auth.sub, auth.tenant_id);
    if (ctx === null || !ctx.membership_active) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'This session is not an active account of this organization', 403, { requestId, details: { reason: 'privacy_subject_unknown' } });
    }
    const open = await this.requests.findOpenForSubject(auth.sub, auth.tenant_id, type);
    if (open !== null) return { created: false, request: this.view(open) };

    const personalOwner = ctx.tenant_kind === 'PERSONAL' && ctx.is_owner;
    const subject_kind: PrivacySubjectKind = personalOwner ? 'ACCOUNT_HOLDER' : 'BUSINESS_MEMBER';
    const actor = SUBJECT(auth.sub);
    let r = await this.requests.create({ product: 'SIGN', request_type: type, subject_kind, channel: 'IN_APP', subject_user_id: auth.sub, subject_tenant_id: auth.tenant_id, actor, now });
    r = await this.requests.transition(r.id, 'IDENTITY_VALIDATED', SYSTEM, { now, payload: { method: 'authenticated_session' } });
    r = await this.requests.transition(r.id, 'DATA_INVENTORY', SYSTEM, {
      now,
      patch: { inventory: { ...(await this.sign.inventory({ subject: { tenant_id: auth.tenant_id, user_id: auth.sub }, email: null })), legal_hold: ctx.legal_hold } },
    });
    if (type === 'DELETION') r = await this.afterDeletionInventory(r, ctx, personalOwner, now);
    this.log.log(`privacy request ${r.reference} ${type} received in-app (${subject_kind}) status=${r.status}`);
    return { created: true, request: this.view(r) };
  }

  private async afterDeletionInventory(r: PrivacyRequestRecord, ctx: PrivacySubjectContext, personalOwner: boolean, now: Date): Promise<PrivacyRequestRecord> {
    let cur = r;
    if (personalOwner) {
      // §3.2 "Close account becomes a step of the deletion request": while execution
      // is staged OFF, the close the app performed before (sending stops, convenience
      // data purged) runs now and the rest waits for the privacy team. With execution
      // ON the execution performs the close itself (and records its counts).
      const state = await this.risk.riskStateOf(ctx.tenant_id);
      if (!privacyDeletionExecutionEnabled() && state !== null && state.state !== 'closed' && !ctx.legal_hold) {
        await this.risk.close(ctx.tenant_id, ctx.user_id, 'owner_closed', now, { closed_by: 'owner', note: `privacy request ${cur.reference}` });
        await this.purge?.purgeForAccountClose({ tenant_id: ctx.tenant_id, user_id: ctx.user_id });
        await this.savedData?.purgeForAccountClose({ tenant_id: ctx.tenant_id, user_id: ctx.user_id });
        await this.requests.recordEvent(cur.id, 'ACCOUNT_CLOSED', SYSTEM, { step: 'close' }, now);
      }
    } else {
      cur = await this.requests.transition(cur.id, 'REFERRED_TO_ORGANIZATION', SYSTEM, {
        now,
        patch: { referred_tenant_id: ctx.tenant_id },
        payload: { referral: 'organization_documents', aramo_fallback: true },
      });
    }
    if (ctx.legal_hold) {
      await this.requests.recordEvent(cur.id, 'LEGAL_HOLD', SYSTEM, { reason: 'tenant_legal_hold' }, now);
      return cur;
    }
    if (!privacyDeletionExecutionEnabled()) return cur;
    cur = await this.requests.transition(cur.id, 'EXECUTING', SYSTEM, { now, payload: { authorized_by: 'authenticated_self_service' } });
    try {
      const res = await this.execution.execute(cur.id, now);
      if (res.status !== 'skipped') return res.request;
    } catch {
      // Left in EXECUTING for the execution worker's retry.
    }
    return (await this.requests.findById(cur.id)) ?? cur;
  }

  // ── Web (no sign-in) ──

  async startWeb(body: { email?: unknown; request_type?: unknown } | undefined, ip: string | null, requestId: string, now: Date = new Date()): Promise<{ received: true }> {
    const type = body?.request_type ?? 'DELETION';
    if (!isPrivacyRequestType(type)) throw bad(requestId, 'Choose one of the listed request types', 'invalid_request_type');
    if (!isPlausibleEmail(body?.email)) throw bad(requestId, 'Enter a valid email address', 'invalid_email');
    if (!privacyEmailKeyAvailable()) {
      throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'Online privacy requests are not available right now. Email privacy@aramo.ai.', 503, { requestId, details: { reason: 'privacy_requests_unavailable' } });
    }
    const email = normalizePrivacyEmail(body.email as string);
    const base = signBaseUrl();
    // Same answer whatever happens next: over budget, unknown email or a send failure.
    if (base === null || !this.budget.allow(`ip:${ip ?? 'unknown'}`, now.getTime())) return { received: true };
    if ((await this.requests.proofCountSince(email, new Date(now.getTime() - PRIVACY_WEB_EMAIL_BUDGET_WINDOW_MS))) >= PRIVACY_WEB_EMAIL_BUDGET_MAX) return { received: true };
    const proof = await this.requests.issueEmailProof({ email, request_type: type, product: 'SIGN', now });
    const link = `${base}${PRIVACY_DELETE_PAGE_PATH}#token=${proof.token}`;
    try {
      await this.mailer.send({ to: email, subject: 'Confirm your Aramo Sign privacy request', html: proofHtml(link, type), text: proofText(link, type) });
    } catch (err) {
      this.log.warn(`privacy proof email failed: ${(err as Error).name}`);
    }
    return { received: true };
  }

  async verifyWeb(body: { token?: unknown } | undefined, ip: string | null, requestId: string, now: Date = new Date()): Promise<SignPrivacyRequestView> {
    if (typeof body?.token !== 'string') throw invalidLink(requestId);
    if (!this.budget.allow(`verify:${ip ?? 'unknown'}`, now.getTime(), 30)) throw invalidLink(requestId);
    if (!privacyEmailKeyAvailable()) throw invalidLink(requestId);
    const proof = await this.requests.consumeEmailProof(body.token, now);
    if (proof === null) throw invalidLink(requestId);
    if (proof.kind === 'repeat') {
      const existing = await this.requests.findById(proof.request_id);
      if (existing === null) throw invalidLink(requestId);
      return this.view(existing);
    }
    const account = await this.subjects.findAccountByEmail(proof.email);
    const ctx = account === null ? null : await this.subjects.context(account.user_id, account.tenant_id);
    const subject_kind: PrivacySubjectKind =
      ctx === null ? 'GUEST_SIGNER' : !ctx.user_active || !ctx.membership_active ? 'FORMER_USER' : ctx.tenant_kind === 'PERSONAL' && ctx.is_owner ? 'ACCOUNT_HOLDER' : 'BUSINESS_MEMBER';
    let r = await this.requests.create({
      product: proof.product,
      request_type: proof.request_type,
      subject_kind,
      channel: 'WEB',
      contact_protected: proof.contact,
      actor: SYSTEM,
      now,
    });
    await this.requests.linkProof(proof.proof_id, r.id);
    r = await this.requests.transition(r.id, 'IDENTITY_VALIDATED', SYSTEM, { now, payload: { method: 'email_ownership_proof' } });
    const inventory = await this.sign.inventory({ subject: ctx === null ? null : { tenant_id: ctx.tenant_id, user_id: ctx.user_id }, email: proof.email });
    r = await this.requests.transition(r.id, 'DATA_INVENTORY', SYSTEM, {
      now,
      patch: {
        subject_user_id: ctx?.user_id ?? null,
        subject_tenant_id: ctx?.tenant_id ?? null,
        inventory: { ...inventory, account_found: ctx !== null, legal_hold: ctx?.legal_hold ?? false },
      },
    });
    this.log.log(`privacy request ${r.reference} ${r.request_type} received on the web (${subject_kind})`);
    return this.view(r);
  }

  async statusWeb(body: { reference?: unknown; email?: unknown } | undefined, ip: string | null, requestId: string, now: Date = new Date()): Promise<SignPrivacyRequestView> {
    if (!this.budget.allow(`status:${ip ?? 'unknown'}`, now.getTime(), 30)) throw notFound(requestId);
    const ref = normalizePrivacyReference(body?.reference);
    if (ref === null || !isPlausibleEmail(body?.email) || !privacyEmailKeyAvailable()) throw notFound(requestId);
    const r = await this.requests.findByReference(ref);
    if (r === null || !this.requests.contactMatches(r, body.email as string)) throw notFound(requestId);
    return this.view(r);
  }
}

const TYPE_TEXT: Record<PrivacyRequestType, string> = {
  DELETION: 'delete your Aramo Sign account and data',
  ACCESS: 'see the personal data Aramo Sign holds about you',
  EXPORT: 'receive a copy of your Aramo Sign data',
  CORRECTION: 'correct your Aramo Sign data',
};

function proofText(link: string, type: PrivacyRequestType): string {
  return [
    `Someone (we hope you) asked to ${TYPE_TEXT[type]}.`,
    '',
    'To confirm that this is your email address and send the request, open this link within one hour:',
    link,
    '',
    'If you did not ask for this, ignore this email; nothing happens.',
    '',
    'Aramo Sign is developed by Astre Consulting Services Inc. Questions: privacy@aramo.ai',
  ].join('\n');
}

function proofHtml(link: string, type: PrivacyRequestType): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<p>Someone (we hope you) asked to ${esc(TYPE_TEXT[type])}.</p><p>To confirm that this is your email address and send the request, open this link within one hour:</p><p><a href="${esc(link)}">Confirm my privacy request</a></p><p>If you did not ask for this, ignore this email; nothing happens.</p><p>Aramo Sign is developed by Astre Consulting Services Inc. Questions: <a href="mailto:privacy@aramo.ai">privacy@aramo.ai</a></p>`;
}
