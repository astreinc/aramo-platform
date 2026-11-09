import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { EntitlementRepository, isCapability } from '@aramo/entitlement';
import {
  GEO_IP_PORT,
  IdentityProviderPolicyService,
  IdentityRepository,
  IdentityService,
  NATIVE_INTEGRITY_CHECK,
  PERSONAL_ALLOWED_COUNTRIES,
  PERSONAL_OTP_MAX_ATTEMPTS,
  PERSONAL_OTP_TTL_MS,
  PERSONAL_TENANT_CAPABILITIES,
  PersonalSignupRepository,
  ROBOT_CHECK_PORT,
  SMS_VERIFICATION_PORT,
  TenantRepository,
  TenantService,
  canonicalEmailForDuplicates,
  checkPersonalOtp,
  classifyEmailDomain,
  extractEmailDomain,
  generatePersonalOtp,
  hashPersonalOtp,
  initialRiskState,
  mayResendPersonalOtp,
  normalizeE164,
  normalizeEmail,
  personalPilotCap,
  PERSONAL_PROVISIONING_STALE_MS,
  personalRiskConfig,
  personalSignupMode,
  phoneRegion,
  ratePersonalSignup,
  safeGeoLookup,
  geoEvidenceOf,
  nativeSignupRequestHash,
  type GeoIpPort,
  type NativeIntegrityCheck,
  type PersonalRiskDecision,
  type PersonalSignupRow,
  type RobotCheckPort,
  type SmsVerificationPort,
} from '@aramo/identity';
import { MAILER_PORT, type MailerPort } from '@aramo/mailer';
import {
  LEGAL_DOCUMENTS,
  LEGAL_DOCUMENT_REGISTRY,
  LegalAcceptanceService,
  PERSONAL_LEGAL_DOCUMENT_KEYS,
  effectivePersonalLegalDocument,
  legalEffectiveFrom,
  type LegalDocumentVersion,
} from '@aramo/subscription';

import { LegalTextSource } from './legal-text.source.js';
import { SignupBudget, federatedSignInLinks } from './sign-signup.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §3 — the PUBLIC Personal
// (Free) signup. Dark unless SIGN_PERSONAL_SIGNUP_MODE is `invite` or `open` (the
// controller answers 404 otherwise; ships `off`).
//
//   start         eligibility (personal email only; US / IN phone region and
//                 declared residence — hard checks), robot check, risk rating
//                 (§6.2; every signal + the decision + the GeoLite2 evidence
//                 stored). The network country is a risk signal only (Architect
//                 ruling 2026-10-21): outside the allowed set or UNKNOWN adds risk
//                 points, never a refusal by itself. Email code. Always
//                 the same 202 for an address that already has an account
//                 (plus a "you already have an account" email) — non-enumerating.
//   verify-email  the code proves the address; reveals the next step from the
//                 decision made at start (allow → terms, step_up → phone, review).
//                 While SMS is unavailable a step-up goes to review instead (PO
//                 2026-10-21 "Review replaces phone"): next = review.
//   phone/*       step-up phone code (SMS port; `disabled` in production → sent:false).
//   terms         the exact APPROVED Personal Terms, Privacy Notice and AUP — null
//                 while any is not approved (complete is refused).
//   complete      PROVISIONED PERSONAL tenant ([core, sign]) + owner with
//                 tenant_owner ONLY (system authority; no product-owner role),
//                 Cognito-free with no ExternalIdentity, enforced cohort with no
//                 pin (Apple Go-Live R-4: allowed {google, apple}; the owner's first
//                 federation pins), TenantRiskState, legal acceptances. No subscription, no Stripe:
//                 the FREE subscription opens only after federated binding.

export const PERSONAL_SIGNUP_SYSTEM_ACTOR_ID = '01900000-0000-7000-8000-00000000519f';
export const PERSONAL_SIGNUP_AUDIT_SOURCE = 'sign.personal_signup';
// Directive v1.1 §4 (correction A) — tenant_owner ONLY.
export const PERSONAL_OWNER_ROLE_KEYS = ['tenant_owner'] as const;
// ToS v2.0 — the same keys as the registry's PERSONAL_LEGAL_DOCUMENT_KEYS (one list; this name is
// kept for its importers). The terms key is `sign.terms_of_service`: until v2.0 is effective,
// effectivePersonalLegalDocument() resolves it to the Personal Terms 1.0.
export const PERSONAL_LEGAL_KEYS = PERSONAL_LEGAL_DOCUMENT_KEYS;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_STARTS_PER_EMAIL_PER_DAY = 5;
const NAME_MAX = 100;

export type PersonalNextStep = 'phone' | 'terms' | 'review';

export interface PersonalCompleteResult {
  status: 'PROVISIONED' | 'PROVISIONING';
  email: string;
  // Apple Go-Live R-5 — the done step offers Google and Apple (each the login with its idp hint).
  sign_in: { google: string; apple: string };
  // §6.3 — the account exists but is held: for review, or until phone assurance.
  held: 'review' | 'phone_verification_required' | null;
}

export interface PersonalTermsDocument {
  key: string;
  version: string;
  url: string;
  sha256: string;
}

/** M-A11 §2.2 — the exact text of one effective Personal document (native terms screen). */
export interface PersonalTermsText {
  key: string;
  version: string;
  sha256: string;
  effective_at: string;
  text: string;
}

/**
 * M-A11 — the signup client. Absent or `web`: the browser (Turnstile, `{key, version}`
 * acceptances), exactly as before. `android`: the native app (Play Integrity,
 * `{key, version, sha256}` acceptances). Apple Go-Live R-9 / W2 — `ios`: the iPhone app
 * (App Attest), otherwise exactly as `android`. Anything else is refused.
 */
export type PersonalSignupClient = 'web' | 'android' | 'ios';

function signupClient(v: unknown, requestId: string): PersonalSignupClient {
  if (v === undefined || v === 'web') return 'web';
  if (v === 'android' || v === 'ios') return v;
  throw new AramoError('VALIDATION_ERROR', 'Unsupported client', 400, { requestId, details: { field: 'client' } });
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length === 0 || t.length > max ? null : t;
}

function esc(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function refusal(requestId: string, reason: string, message: string, extra: Record<string, unknown> = {}): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason, ...extra } });
}

const LOCATION_MESSAGE = 'Aramo Sign Personal is currently available in the United States and India.';

function locationRefusal(requestId: string): AramoError {
  return refusal(requestId, 'personal_location_not_supported', LOCATION_MESSAGE);
}

function neutralRefusal(requestId: string): AramoError {
  return refusal(requestId, 'personal_signup_refused', 'We can’t create a personal account with these details.');
}

function codeError(requestId: string, outcome: 'mismatch' | 'expired' | 'exhausted' | 'none', attempts_remaining?: number): AramoError {
  if (outcome === 'expired') return refusal(requestId, 'code_expired', 'This code has expired. Ask for a new one.');
  if (outcome === 'exhausted') return refusal(requestId, 'code_attempts_exceeded', 'Too many attempts. Ask for a new code.');
  return refusal(requestId, 'code_invalid', 'This code is not correct.', attempts_remaining === undefined ? {} : { attempts_remaining });
}

function remaining(attemptsBefore: number): number {
  return Math.max(0, PERSONAL_OTP_MAX_ATTEMPTS - attemptsBefore - 1);
}

/**
 * What a completed account is held for (§6.3): review, unmet phone step-up, or
 * nothing. Without SMS a step-up is held for review (an operator's review lifts it).
 */
export function heldFor(decision: string, phone_verified: boolean, sms_available = true): PersonalHold {
  const r = initialRiskState(decision as PersonalRiskDecision, phone_verified, sms_available);
  if (r.state !== 'review') return null;
  return r.step_up_required && sms_available ? 'phone_verification_required' : 'review';
}

export type PersonalHold = 'review' | 'phone_verification_required' | null;

function nextFor(decision: string, sms_available = true): PersonalNextStep {
  if (decision === 'review') return 'review';
  if (decision === 'step_up') return sms_available ? 'phone' : 'review';
  return 'terms';
}

/** The tenant name of a Personal account (deterministic per request, unique). */
export function personalTenantName(row: Pick<PersonalSignupRow, 'id' | 'display_name'>): string {
  return `${row.display_name} (Personal ${row.id.replace(/-/g, '').slice(-8)})`;
}

@Injectable()
export class PersonalSignupService {
  private readonly log = new Logger(PersonalSignupService.name);
  private readonly legal: readonly LegalDocumentVersion[];

  constructor(
    private readonly requests: PersonalSignupRepository,
    private readonly identity: IdentityService,
    private readonly identityRepo: IdentityRepository,
    private readonly tenants: TenantRepository,
    private readonly tenantSvc: TenantService,
    private readonly entitlements: EntitlementRepository,
    private readonly idpPolicy: IdentityProviderPolicyService,
    private readonly acceptances: LegalAcceptanceService,
    private readonly budget: SignupBudget,
    @Inject(MAILER_PORT) private readonly mailer: MailerPort,
    @Inject(GEO_IP_PORT) private readonly geo: GeoIpPort,
    @Inject(SMS_VERIFICATION_PORT) private readonly sms: SmsVerificationPort,
    @Inject(ROBOT_CHECK_PORT) private readonly robot: RobotCheckPort,
    @Inject(NATIVE_INTEGRITY_CHECK) private readonly integrity: NativeIntegrityCheck,
    private readonly texts: LegalTextSource,
    @Optional() @Inject(LEGAL_DOCUMENT_REGISTRY) legal?: readonly LegalDocumentVersion[],
  ) {
    this.legal = legal ?? LEGAL_DOCUMENTS;
  }

  // ── terms (§3.4) ───────────────────────────────────────────────────────────

  /**
   * The exact versions of the three Personal documents in effect at `now`, or
   * null while any of them has none (nothing unapproved is ever presented). The
   * registry is read by key; an approved version that is only upcoming (E-5:
   * effective_from in the future) is not presented until it takes effect.
   */
  currentTerms(now: Date = new Date()): PersonalTermsDocument[] | null {
    const docs: PersonalTermsDocument[] = [];
    for (const key of PERSONAL_LEGAL_KEYS) {
      // ToS v2.0 — the document in effect for the key (its predecessor while it has none).
      const doc = effectivePersonalLegalDocument(key, this.legal, now);
      if (doc === null || doc.url === null) return null;
      docs.push({ key: doc.key, version: doc.version, url: doc.url, sha256: doc.sha256 });
    }
    return docs;
  }

  /**
   * M-A11 §2.2 — the text of a document that is CURRENTLY effective for Personal
   * signup (one of currentTerms()), with the registry's sha256; the served bytes hash
   * to it. Anything else (unknown, superseded, upcoming, draft, a text that does not
   * match its hash) is null → 404.
   */
  termsText(key: unknown, version: unknown, now: Date = new Date()): PersonalTermsText | null {
    if (typeof key !== 'string' || typeof version !== 'string') return null;
    for (const k of PERSONAL_LEGAL_KEYS) {
      const doc = effectivePersonalLegalDocument(k, this.legal, now);
      if (doc === null || doc.url === null || doc.key !== key || doc.version !== version) continue;
      const at = legalEffectiveFrom(doc);
      const text = at === null ? null : this.texts.text(doc);
      if (text === null || at === null) return null;
      return { key: doc.key, version: doc.version, sha256: doc.sha256, effective_at: new Date(at).toISOString(), text };
    }
    return null;
  }

  private approvedDocument(key: string, version: string): LegalDocumentVersion | null {
    return this.legal.find((d) => (d.key as string) === key && d.version === version && d.status === 'APPROVED' && d.url !== null) ?? null;
  }

  // ── start (§3.1–§3.3, §6.1, §6.2, §6.6) ────────────────────────────────────

  async start(input: {
    client?: unknown;
    integrity_token?: unknown;
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    residence?: unknown;
    robot_token?: unknown;
    invite_code?: unknown;
    hp?: unknown;
    elapsed_ms?: unknown;
    ip: string;
    request_id: string;
    now?: Date;
  }): Promise<{ signup_id: string }> {
    const now = input.now ?? new Date();
    const rid = input.request_id;
    // M-A11 §2.1 — a native start is bound to its integrity token by the hash of the
    // body EXACTLY as received (before any trim or normalization below).
    const client = signupClient(input.client, rid);
    // Apple Go-Live R-9 — the iOS app binds its App Attest key with the same requestHash.
    let requestHash: string | null = null;
    if (client !== 'web') {
      if (typeof input.elapsed_ms !== 'number' || !Number.isSafeInteger(input.elapsed_ms)) {
        throw new AramoError('VALIDATION_ERROR', 'elapsed_ms must be an integer', 400, { requestId: rid, details: { field: 'elapsed_ms' } });
      }
      requestHash = nativeSignupRequestHash({
        client: input.client,
        name: input.name,
        email: input.email,
        phone: input.phone,
        residence: input.residence,
        invite_code: input.invite_code,
        hp: input.hp,
        elapsed_ms: input.elapsed_ms,
      });
    }
    const name = cleanText(input.name, NAME_MAX);
    const typed = cleanText(input.email, 254);
    if (name === null || name.length < 2 || typed === null || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed)) {
      throw new AramoError('VALIDATION_ERROR', 'Enter your name and your personal email address', 400, { requestId: rid });
    }
    const email = normalizeEmail(typed);

    // §2 — one classification: Personal accepts only `personal`.
    const cls = classifyEmailDomain(extractEmailDomain(email));
    if (cls === 'business') {
      throw refusal(rid, 'business_email_use_business_signup', 'This looks like a work email. Create a Business organization instead.');
    }
    if (cls === 'disposable') throw refusal(rid, 'personal_email_not_allowed', 'Use a permanent personal email address.');
    if (cls !== 'personal') throw new AramoError('VALIDATION_ERROR', 'Enter a valid personal email address', 400, { requestId: rid });

    const phone = typeof input.phone === 'string' ? normalizeE164(input.phone) : null;
    if (phone === null) {
      throw new AramoError('VALIDATION_ERROR', 'Enter a valid mobile number', 400, { requestId: rid, details: { field: 'phone' } });
    }
    const residence = typeof input.residence === 'string' ? input.residence.trim().toUpperCase() : '';

    // §6.6 — declared residence and phone region stay hard US / IN eligibility
    // (PO decision). The network country is NOT checked here: per the Architect
    // ruling of 2026-10-21 GeoLite2 is a risk signal, never proof of residence and
    // never a block by itself — it is rated below (outside / UNKNOWN add points).
    const allowed = PERSONAL_ALLOWED_COUNTRIES();
    const region = phoneRegion(phone);
    if (!allowed.includes(residence) || region === null || region !== residence) throw locationRefusal(rid);

    // §10 — invite mode: a valid, unexpired, unused code bound to this address,
    // and room under the pilot cap.
    let invite_id: string | null = null;
    if (personalSignupMode() === 'invite') {
      const code = typeof input.invite_code === 'string' ? input.invite_code.trim() : '';
      if (code === '') throw refusal(rid, 'invite_required', 'Personal accounts are invitation-only for now. Enter your invitation code.');
      const invite = await this.requests.findValidInvite(code, email, now);
      if (invite === null) throw refusal(rid, 'invite_invalid', 'This invitation code is not valid for this email address.');
      if ((await this.requests.activePersonalTenantCount()) >= personalPilotCap()) {
        throw refusal(rid, 'personal_pilot_full', 'Personal accounts are not open to more people yet.');
      }
      invite_id = invite.id;
    }

    // §6.1 — the robot check, server-side; unavailable is refused (fail closed).
    // M-A11 §2 — from the Android app the native integrity check takes its place with
    // the same verdicts (pass; fail → robot_check_failed → refused; unavailable → refused).
    // Apple Go-Live R-9 — routed by platform: the iPhone app is checked with App Attest.
    const robot =
      requestHash !== null
        ? await this.integrity.verify({
            platform: client === 'ios' ? 'ios' : 'android',
            token: typeof input.integrity_token === 'string' ? input.integrity_token : null,
            request_hash: requestHash,
            now,
          })
        : await this.robot.verify(typeof input.robot_token === 'string' ? input.robot_token : null, input.ip);
    if (robot.verdict === 'unavailable') {
      this.log.warn('personal signup refused: robot check unavailable (fail closed)');
      throw neutralRefusal(rid);
    }
    // Apple Go-Live R-9 (replay) — an App Attest key id is accepted once (UNIQUE on the row).
    const attest_key_id =
      robot.verdict === 'pass' && client === 'ios' && 'attest_key_id' in robot && typeof robot.attest_key_id === 'string' ? robot.attest_key_id : null;
    if (attest_key_id !== null && (await this.requests.attestKeyIdUsed(attest_key_id))) {
      this.log.warn('personal signup refused: native integrity (ios) attestation replayed');
      throw neutralRefusal(rid);
    }

    // Everything below that concerns the address answers the same 202.
    const decoy = { signup_id: randomUUID() };
    if (!this.budget.allow(`personal:${input.ip}`, now.getTime())) return decoy;
    // Gmail dots / +tag are folded ONLY for duplicate detection. The account is
    // created for the address exactly as typed, and binding (auth-service
    // reconcile) matches the Google-asserted email normalized-EXACT: if Google
    // reports a different dotted form of the same mailbox (e.g. typed
    // jane.doe@gmail.com, Google says janedoe@gmail.com) the Google sign-in does
    // NOT bind and the tenant stays PROVISIONED (and lapses after 7 days). The
    // done page tells the person to use the Google account for the typed address.
    const canonical = canonicalEmailForDuplicates(email);
    const since = new Date(now.getTime() - DAY_MS);
    if ((await this.requests.countStartsSince(canonical, since)) >= MAX_STARTS_PER_EMAIL_PER_DAY) return decoy;

    // An existing account answers the same 202 + an "already have an account"
    // email — EXCEPT an earlier Personal signup of this address that lapsed
    // unbound (never signed in): that one resumes through the normal flow.
    const existingUser = await this.identity.findUserByEmail(email);
    const resumable = existingUser === null ? null : await this.requests.findResumableLapsed(email);
    if (existingUser !== null && resumable === null) {
      await this.send(email, 'You already have an Aramo account', [
        'Someone (hopefully you) tried to create a new Aramo Sign personal account with this email address.',
        'This address already belongs to an Aramo account, so no new account was created. Sign in instead.',
      ], { label: 'Sign in to Aramo Sign', href: federatedSignInLinks().google });
      return decoy;
    }

    // §6.2 — the risk rating; every signal and the decision are stored.
    // The GeoLite2 lookup never throws: a missing / unreadable database or a lookup
    // error is UNKNOWN (country null) — never evidence of any country.
    const [ipCount, alias, phoneReused, geo] = await Promise.all([
      this.requests.countByIpSince(input.ip, since),
      this.requests.gmailAliasOfExisting(canonical, email),
      this.requests.phoneUsedByAnother(phone, canonical, resumable?.tenant_id ?? null),
      safeGeoLookup(this.geo, input.ip, now),
    ]);
    const network = geo.network_kind;
    const ipCountry = geo.country;
    const elapsed = typeof input.elapsed_ms === 'number' && Number.isFinite(input.elapsed_ms) ? input.elapsed_ms : null;
    const rating = ratePersonalSignup(
      {
        robot: robot.verdict,
        network,
        ip_signups_24h: ipCount + 1,
        phone_region: region,
        ip_country: ipCountry,
        allowed_countries: allowed,
        gmail_alias_of_existing: alias,
        elapsed_ms: elapsed,
        honeypot_filled: typeof input.hp === 'string' ? input.hp.trim() !== '' : input.hp !== undefined && input.hp !== null && input.hp !== false,
        name,
        email_local_part: email.slice(0, email.lastIndexOf('@')),
        phone_reused: phoneReused,
      },
      personalRiskConfig(),
    );
    let row: PersonalSignupRow;
    try {
      row = await this.requests.create({
        email,
        canonical_email: canonical,
        display_name: name,
        phone_e164: phone,
        declared_residence: residence,
        ip: input.ip === 'unknown' ? null : input.ip,
        ip_country: ipCountry,
        phone_region: region,
        network_kind: network,
        geo_evidence: geoEvidenceOf(geo),
        risk_points: rating.points,
        risk_signals: rating.signals,
        decision: rating.decision,
        invite_id,
        status: rating.decision === 'refuse' ? 'REFUSED' : 'PENDING',
        ...(attest_key_id === null ? {} : { attest_key_id }),
        now,
      });
    } catch (err) {
      // A concurrent replay of the same attestation loses the UNIQUE race: refused alike.
      if (attest_key_id !== null && (err as { code?: unknown }).code === 'P2002') {
        this.log.warn('personal signup refused: native integrity (ios) attestation replayed');
        throw neutralRefusal(rid);
      }
      throw err;
    }
    if (rating.decision === 'refuse') throw neutralRefusal(rid);
    await this.sendEmailCode(row, now);
    return { signup_id: row.id };
  }

  /** Resend the email code (60 s gap; 5 a day per address). Always the same answer. */
  async resendEmail(input: { signup_id?: unknown; ip: string; request_id: string; now?: Date }): Promise<void> {
    const now = input.now ?? new Date();
    if (!this.budget.allow(`personal:${input.ip}`, now.getTime())) return;
    const row = await this.live(input.signup_id, now);
    if (row === null || row.status !== 'PENDING') return;
    const sends = await this.requests.emailSendsSince(row.canonical_email, new Date(now.getTime() - DAY_MS));
    if (!mayResendPersonalOtp({ last_sent_at: row.email_otp_last_sent_at, sends_last_24h: sends, now })) return;
    await this.sendEmailCode(row, now);
  }

  // ── verify-email (§3.2) ────────────────────────────────────────────────────

  async verifyEmail(input: { signup_id?: unknown; code?: unknown; request_id: string; now?: Date }): Promise<{ next: PersonalNextStep }> {
    const now = input.now ?? new Date();
    const row = await this.live(input.signup_id, now);
    // An unknown id answers exactly like a wrong code (a decoy id from start is indistinguishable).
    if (row === null || row.status !== 'PENDING') throw codeError(input.request_id, 'mismatch');
    const outcome = checkPersonalOtp(
      { hash: row.email_otp_hash, expires_at: row.email_otp_expires_at, attempts: row.email_otp_attempts },
      row.id,
      'email',
      input.code,
      now,
    );
    if (outcome !== 'ok') {
      if (outcome === 'mismatch') await this.requests.recordEmailAttempt(row.id, now);
      throw codeError(input.request_id, outcome, outcome === 'mismatch' ? remaining(row.email_otp_attempts) : undefined);
    }
    if (!(await this.requests.markEmailVerified(row.id, now))) throw codeError(input.request_id, 'mismatch');
    return { next: nextFor(row.decision, this.sms.configured) };
  }

  // ── phone (§6.3) ───────────────────────────────────────────────────────────

  async sendPhoneCode(input: { signup_id?: unknown; request_id: string; now?: Date }): Promise<{ sent: boolean }> {
    const now = input.now ?? new Date();
    const row = await this.emailVerified(input.signup_id, input.request_id, now);
    if (!this.sms.configured) return { sent: false };
    const sends = await this.requests.phoneSendsSince(row.phone_e164, new Date(now.getTime() - DAY_MS));
    if (!mayResendPersonalOtp({ last_sent_at: row.phone_otp_last_sent_at, sends_last_24h: sends, now })) {
      throw refusal(input.request_id, 'personal_code_rate_limited', 'Wait a minute before asking for another code.');
    }
    const code = generatePersonalOtp();
    await this.requests.setPhoneOtp(row.id, hashPersonalOtp(row.id, 'phone', code), new Date(now.getTime() + PERSONAL_OTP_TTL_MS), now);
    const res = await this.sms
      .send(row.phone_e164, `Your Aramo Sign verification code is ${code}. It expires in 10 minutes. Aramo will never ask you for this code.`)
      .catch((err: unknown) => {
        this.log.warn(`phone code delivery failed: ${(err as Error).message}`);
        return { ok: false, ref: null };
      });
    return { sent: res.ok };
  }

  async verifyPhone(input: { signup_id?: unknown; code?: unknown; request_id: string; now?: Date }): Promise<{ next: 'terms' }> {
    const now = input.now ?? new Date();
    const row = await this.emailVerified(input.signup_id, input.request_id, now);
    const outcome = checkPersonalOtp(
      { hash: row.phone_otp_hash, expires_at: row.phone_otp_expires_at, attempts: row.phone_otp_attempts },
      row.id,
      'phone',
      input.code,
      now,
    );
    if (outcome !== 'ok') {
      if (outcome === 'mismatch') await this.requests.recordPhoneAttempt(row.id, now);
      throw codeError(input.request_id, outcome, outcome === 'mismatch' ? remaining(row.phone_otp_attempts) : undefined);
    }
    await this.requests.markPhoneVerified(row.id, now);
    // Directive §6.3 — review is a separate gate; the signup continues to terms either way.
    return { next: 'terms' };
  }

  // ── complete (§3.4–§3.6, §4) ───────────────────────────────────────────────

  async complete(input: {
    signup_id?: unknown;
    accept?: unknown;
    client?: unknown;
    ip: string;
    user_agent?: string | null;
    request_id: string;
    now?: Date;
  }): Promise<PersonalCompleteResult> {
    const now = input.now ?? new Date();
    const rid = input.request_id;
    // M-A11 §2.2 — the client is passed again at complete (it is not stored at start).
    const client = signupClient(input.client, rid);
    // Apple Go-Live R-5 — the done step offers Google and Apple.
    const links = federatedSignInLinks();
    const sign_in = { google: links.google, apple: links.apple };
    const row = typeof input.signup_id === 'string' ? await this.requests.findById(input.signup_id).catch(() => null) : null;
    if (row === null) throw this.notFound(rid);
    if (row.status === 'PROVISIONED') return { status: 'PROVISIONED', email: row.email, sign_in, held: heldFor(row.decision, row.phone_verified_at !== null, this.sms.configured) };
    if (row.status === 'PROVISIONING' && now.getTime() - row.updated_at.getTime() < PERSONAL_PROVISIONING_STALE_MS) {
      return { status: 'PROVISIONING', email: row.email, sign_in, held: heldFor(row.decision, row.phone_verified_at !== null, this.sms.configured) };
    }
    if (!['EMAIL_VERIFIED', 'FAILED', 'PROVISIONING'].includes(row.status) || row.expires_at.getTime() <= now.getTime()) throw this.notFound(rid);
    if (row.decision === 'refuse') throw neutralRefusal(rid);

    // §3.4 / §10 — the exact APPROVED versions, all three, or nothing completes.
    const terms = this.currentTerms(now);
    if (terms === null) {
      throw refusal(rid, 'legal_documents_not_approved', 'Personal accounts are not open yet.');
    }
    const accepted = Array.isArray(input.accept) ? (input.accept as unknown[]) : [];
    const entry = (a: unknown): { key?: unknown; version?: unknown; sha256?: unknown } | null =>
      typeof a === 'object' && a !== null ? (a as { key?: unknown; version?: unknown; sha256?: unknown }) : null;
    const acceptedDocs: LegalDocumentVersion[] = [];
    for (const t of terms) {
      // An entry that carries a sha256 must name the registry's hash (stricter only; the web
      // sends none). From the app every entry must carry it (M-A11 §2.2; the iPhone app alike).
      const hit = accepted.some((a) => {
        const e = entry(a);
        if (e === null || e.key !== t.key || e.version !== t.version) return false;
        if (client !== 'web' || e.sha256 !== undefined) return e.sha256 === t.sha256;
        return true;
      });
      const doc = this.approvedDocument(t.key, t.version);
      if (!hit || doc === null || doc.sha256 !== t.sha256) throw refusal(rid, 'terms_not_accepted', 'Accept the terms to continue', { key: t.key, version: t.version });
      acceptedDocs.push(doc);
    }
    // M-A11 §2.2 — from the app, exactly one entry per effective document: an extra, duplicate
    // or stale entry (a document that changed after the app fetched it) is refused.
    if (client !== 'web') {
      const exact =
        accepted.length === terms.length &&
        accepted.every((a) => {
          const e = entry(a);
          return e !== null && terms.some((t) => e.key === t.key && e.version === t.version && e.sha256 === t.sha256);
        }) &&
        new Set(accepted.map((a) => entry(a)?.key)).size === accepted.length;
      if (!exact) throw refusal(rid, 'terms_not_accepted', 'Accept the terms to continue');
    }

    // §10 invite mode — the invite is still valid (the pilot cap is checked below,
    // serialized with the claim).
    const inviteMode = personalSignupMode() === 'invite';
    if (inviteMode && (row.invite_id === null || !(await this.requests.inviteStillValid(row.invite_id, now)))) {
      throw refusal(rid, 'invite_invalid', 'This invitation code is no longer valid.');
    }

    const documents = acceptedDocs.map((d) => ({ key: d.key, version: d.version, sha256: d.sha256 }));
    if (row.status === 'PROVISIONING') {
      // A stale claim (the process died mid-saga): re-claim it below via FAILED semantics.
      await this.requests.markFailed(row.id, 'provisioning_stale', now);
    }
    const accepted_by = { documents, ip: input.ip === 'unknown' ? null : input.ip, at: now };
    // Invite mode: the cap count and the claim run under ONE advisory lock, and an
    // in-flight claim counts against the cap — concurrent completes cannot exceed it.
    const claim = inviteMode
      ? await this.requests.claimForProvisioningWithinCap(row.id, accepted_by, personalPilotCap())
      : (await this.requests.claimForProvisioning(row.id, accepted_by))
        ? 'claimed'
        : 'busy';
    if (claim === 'full') throw refusal(rid, 'personal_pilot_full', 'Personal accounts are not open to more people yet.');
    if (claim === 'busy') {
      return { status: 'PROVISIONING', email: row.email, sign_in, held: heldFor(row.decision, row.phone_verified_at !== null, this.sms.configured) };
    }

    try {
      // A lapsed, never-bound earlier signup of this address resumes its SAME
      // tenant and owner (no second tenant or user).
      // Apple Go-Live R-4 — enrolled WITHOUT a pin; an existing pin (a tenant created
      // before R-4 was pinned to google) is never re-pointed or cleared.
      const resumable = await this.requests.findResumableLapsed(row.email);
      if (resumable !== null) {
        await this.idpPolicy.enrollEnforcedTenant(resumable.tenant_id);
        await this.entitlements.grantCapabilities({ tenant_id: resumable.tenant_id, capabilities: PERSONAL_TENANT_CAPABILITIES.filter(isCapability), granted_source: 'SIGNUP', granted_by: PERSONAL_SIGNUP_SYSTEM_ACTOR_ID });
      }
      const adopted = resumable === null ? await this.adopt(row) : null;
      const res = resumable !== null ? { tenant_id: resumable.tenant_id, owner_user_id: resumable.user_id } : (adopted ?? (await this.provision(row, rid)));
      for (const document of acceptedDocs) {
        await this.acceptances.record({
          document,
          context: 'SIGNUP',
          context_ref: row.id,
          tenant_id: res.tenant_id,
          user_id: res.owner_user_id,
          subject_email: row.email,
          accepted_at: now,
          // M-A11 §2 — an acceptance from the app records its origin (IP, user agent).
          ...(client !== 'web' ? { origin: { ip: input.ip === 'unknown' ? null : input.ip, user_agent: input.user_agent ?? null } } : {}),
        });
      }
      await this.requests.completeProvisioning({
        id: row.id,
        tenant_id: res.tenant_id,
        owner_user_id: res.owner_user_id,
        now: new Date(),
        sms_available: this.sms.configured,
        ...(resumable === null ? {} : { resumed_from: resumable.prior_signup_id }),
        ...(client !== 'web' ? { client } : {}),
      });
      this.log.log(`personal signup provisioned tenant ${res.tenant_id}`);
      // Apple Go-Live R-5 / R-13 — Google and Apple; Apple works only when it shares this address.
      await this.send(row.email, 'Your Aramo Sign personal account is ready', [
        `Sign in with the Google account for ${row.email}, or with your Apple ID if it shares this email address.`,
        'If you don’t have one, you can create a Google Account with this email address.',
        `Continue with Apple: ${sign_in.apple}`,
      ], { label: 'Continue with Google', href: sign_in.google });
      return { status: 'PROVISIONED', email: row.email, sign_in, held: heldFor(row.decision, row.phone_verified_at !== null, this.sms.configured) };
    } catch (err) {
      const code = err instanceof AramoError ? err.code : 'INTERNAL_ERROR';
      await this.requests.markFailed(row.id, code, new Date());
      if (code === 'EMAIL_UNAVAILABLE') {
        throw new AramoError('EMAIL_UNAVAILABLE', 'This email address already belongs to an Aramo account. Sign in instead.', 409, { requestId: rid });
      }
      if (code === 'VALIDATION_ERROR') throw err;
      this.log.error(`personal signup failed (${code}): ${(err as Error).message}`);
      throw new AramoError('INTERNAL_ERROR', 'We couldn’t finish creating your account. Try again in a minute.', 500, {
        requestId: rid,
        details: { retryable: true },
      });
    }
  }

  /**
   * Cognito-free provisioning: PERSONAL tenant (no domain claim — P3) → enforced
   * provider cohort WITHOUT a pin (Apple Go-Live R-4: allowed {google, apple}; the
   * owner's first federation sets the pin by compare-and-set) → [core, sign] →
   * owner with tenant_owner ONLY through the system owner authority (§4; no
   * product-owner role), ACTIVE membership, no ExternalIdentity. A failure after
   * the tenant exists soft-disables it.
   */
  private async provision(row: PersonalSignupRow, request_id: string): Promise<{ tenant_id: string; owner_user_id: string }> {
    if ((await this.identity.findUserByEmail(row.email)) !== null) {
      throw new AramoError('EMAIL_UNAVAILABLE', 'This email address is not available', 409, { requestId: request_id, details: {} });
    }
    const role_ids = await this.identity.resolveRoleIdsByKeys([...PERSONAL_OWNER_ROLE_KEYS]);
    const tenant = await this.tenantSvc.provisionTenant({
      name: personalTenantName(row),
      owner_email: row.email,
      actor_user_id: PERSONAL_SIGNUP_SYSTEM_ACTOR_ID,
      invitation_sent: false,
      kind: 'PERSONAL',
      audit_source: PERSONAL_SIGNUP_AUDIT_SOURCE,
      actor_type: 'system',
    });
    try {
      await this.idpPolicy.enrollEnforcedTenant(tenant.id);
      await this.entitlements.grantCapabilities({ tenant_id: tenant.id, capabilities: PERSONAL_TENANT_CAPABILITIES.filter(isCapability), granted_source: 'SIGNUP', granted_by: PERSONAL_SIGNUP_SYSTEM_ACTOR_ID });
      const owner = await this.identity.createFederatedOwnerNoSub({
        email: row.email,
        display_name: row.display_name,
        tenant_id: tenant.id,
        role_keys: [...PERSONAL_OWNER_ROLE_KEYS],
        role_ids,
        actor_user_id: PERSONAL_SIGNUP_SYSTEM_ACTOR_ID,
        request_id,
        owner_role_authority: 'system',
      });
      return { tenant_id: tenant.id, owner_user_id: owner.user.id };
    } catch (err) {
      await this.tenantSvc
        .deactivateTenant({ tenant_id: tenant.id, actor_user_id: PERSONAL_SIGNUP_SYSTEM_ACTOR_ID, reason: 'personal_signup_provisioning_failed', actor_type: 'system' })
        .catch((e: unknown) => this.log.error(`soft-disable of ${tenant.id} failed: ${(e as Error).message}`));
      throw err;
    }
  }

  /** A crashed earlier attempt of THIS request (same deterministic tenant name, live, owned by this address). */
  private async adopt(row: PersonalSignupRow): Promise<{ tenant_id: string; owner_user_id: string } | null> {
    const user = await this.identity.findUserByEmail(row.email);
    if (user === null) return null;
    const tenantIds = await this.identityRepo.findMembershipTenantIdsForUser(user.id);
    if (tenantIds.length !== 1) return null;
    const tenant = await this.tenants.findById(tenantIds[0]!);
    if (tenant === null || !tenant.is_active || tenant.kind !== 'PERSONAL' || tenant.name !== personalTenantName(row)) return null;
    const membership = await this.identityRepo.findMembership({ user_id: user.id, tenant_id: tenant.id });
    if (membership === null || !(await this.identity.findRoleKeysForMembership(membership.id)).includes('tenant_owner')) return null;
    // Apple Go-Live R-4 — unpinned enrollment; never re-points a pin the crashed attempt set.
    await this.idpPolicy.enrollEnforcedTenant(tenant.id);
    await this.entitlements.grantCapabilities({ tenant_id: tenant.id, capabilities: PERSONAL_TENANT_CAPABILITIES.filter(isCapability), granted_source: 'SIGNUP', granted_by: PERSONAL_SIGNUP_SYSTEM_ACTOR_ID });
    return { tenant_id: tenant.id, owner_user_id: user.id };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private notFound(requestId: string): AramoError {
    return new AramoError('NOT_FOUND', 'This signup is invalid or has expired', 404, { requestId });
  }

  private async live(signup_id: unknown, now: Date): Promise<PersonalSignupRow | null> {
    if (typeof signup_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(signup_id)) return null;
    const row = await this.requests.findById(signup_id);
    if (row === null || row.expires_at.getTime() <= now.getTime()) return null;
    return row;
  }

  private async emailVerified(signup_id: unknown, requestId: string, now: Date): Promise<PersonalSignupRow> {
    const row = await this.live(signup_id, now);
    if (row === null || row.status !== 'EMAIL_VERIFIED' || (row.decision as PersonalRiskDecision) === 'refuse') throw this.notFound(requestId);
    return row;
  }

  private async sendEmailCode(row: PersonalSignupRow, now: Date): Promise<void> {
    const code = generatePersonalOtp();
    await this.requests.setEmailOtp(row.id, hashPersonalOtp(row.id, 'email', code), new Date(now.getTime() + PERSONAL_OTP_TTL_MS), now);
    await this.send(row.email, `Your Aramo Sign verification code: ${code}`, [
      `Your verification code is ${code}. It expires in 10 minutes.`,
      'Enter it on the signup page to confirm this email address. If you didn’t ask for this, ignore this email — nothing has been created.',
    ], null);
  }

  private async send(to: string, subject: string, lines: string[], action: { label: string; href: string } | null): Promise<void> {
    const html = [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111827">',
      '<div style="font-weight:700;font-size:18px;margin-bottom:16px">Aramo Sign</div>',
      ...lines.map((l) => `<p style="line-height:1.5">${esc(l)}</p>`),
      action === null
        ? ''
        : `<p style="margin:24px 0"><a href="${esc(action.href)}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(action.label)}</a></p>`,
      '</div>',
    ].join('');
    const text = `${lines.join('\n\n')}${action === null ? '' : `\n\n${action.label}: ${action.href}`}`;
    try {
      await this.mailer.send({ to, subject, html, text });
    } catch (err) {
      this.log.error(`personal signup email failed: ${(err as Error).message}`);
    }
  }
}
