import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import { EsignSenderConsumerGuard, type IdentityRepository, type TenantRepository } from '@aramo/identity';
import { SIGNER_VERIFIED_NUMBER_LABEL } from '@aramo/sign-client';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import {
  SignUserProfileRepository,
  phoneHash,
  type LedgerAppend,
  type NewDelivery,
  type OutboundMessage,
  type OutboundMessagingPort,
  type OutboundSendResult,
  type RecipientMessagingRow,
  type SessionContext,
  type SignMessagingRepository,
  type SignSmsConsentRepository,
  type SmsCertificationRow,
  type UserSmsCodeRow,
  type UserSmsConsentRow,
} from '@aramo/sign';
import {
  SMS_CERTIFICATION_WORDING,
  SMS_CERTIFICATION_WORDING_VERSION,
  SMS_CONSENT_WORDING,
  SMS_CONSENT_WORDING_VERSION,
  signerSmsCodeText,
} from '@aramo/sign-client';

import { DisabledOutboundMessaging, smsText } from '../app/messaging/messaging-adapters.js';
import { RecipientOtpService } from '../app/messaging/recipient-otp.service.js';
import { SenderMessagingService } from '../app/messaging/sender-messaging.service.js';
import { SignMessagingService } from '../app/messaging/sign-messaging.service.js';
import { SmsCertificationService } from '../app/messaging/sms-certification.service.js';
import { SignSmsCertificationController, SignUserSmsConsentController } from '../app/messaging/sms-consent.controller.js';
import { SmsConsentFacts, isCertificationCurrent, isConsentActive } from '../app/messaging/sms-consent-rules.js';
import { SignSmsPlanGate, smsEntitlementOf } from '../app/messaging/sms-plan.gate.js';
import { SignSmsPolicy } from '../app/messaging/sms-policy.service.js';
import { UserSmsConsentService } from '../app/messaging/user-sms-consent.service.js';
import type { SignPlanFeatureReader } from '../app/custom-roles/sign-custom-roles.gate.js';
import { SenderContextService } from '../app/sender/sender-context.service.js';
import type { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';
import { SignFeatureGate } from '../app/sign-feature.gate.js';

// SMS-CONSENT-1 (LOCKED 2026-11-28) — consent for texts to signers: the organization certification
// (R-2), the user's own consent (R-3), Business plans only (R-4), the signer's own number first
// (R-5), STOP on the signer code (R-6), dark (R-8). Stubs only; every time is injected.

const TENANT = '11111111-1111-7111-8111-111111111111';
const ENVELOPE = '22222222-2222-7222-8222-222222222222';
const SIGNER = '33333333-3333-7333-8333-333333333333';
const SESSION = '44444444-4444-7444-8444-444444444444';
const ADMIN = '55555555-5555-7555-8555-555555555555';
const USER = '66666666-6666-7666-8666-666666666666';
const TYPED = '+14155550123';
const OWN = '+14155550199';
const NOW = new Date('2026-11-28T15:00:00.000Z');
const NO_QUIET = { SIGN_MESSAGING_QUIET_HOURS: 'off' } as NodeJS.ProcessEnv;

const LAUNCHED = new SignFeatureGate({ ...FEATURE_AVAILABILITY, 'sign.sms_delivery': 'AVAILABLE', 'sign.sms_otp': 'AVAILABLE' });
const DARK = new SignFeatureGate();

// ── In-memory stores ────────────────────────────────────────────────────────
class FakeConsentRepo {
  certifications: SmsCertificationRow[] = [];
  consents = new Map<string, UserSmsConsentRow>();
  codes: UserSmsCodeRow[] = [];
  signerEmails = new Map<string, string>();
  reads = 0;

  async currentCertification(tenant_id: string) {
    this.reads += 1;
    return [...this.certifications].reverse().find((c) => c.tenant_id === tenant_id && c.withdrawn_at === null) ?? null;
  }
  async certify(i: { id: string; tenant_id: string; user_id: string; wording_version: string; now: Date }) {
    const current = await this.currentCertification(i.tenant_id);
    if (current !== null && current.wording_version === i.wording_version) return current;
    if (current !== null) Object.assign(current, { withdrawn_at: i.now, withdrawn_by_user_id: i.user_id });
    const row = { id: i.id, tenant_id: i.tenant_id, certified_by_user_id: i.user_id, certified_at: i.now, wording_version: i.wording_version, withdrawn_at: null, withdrawn_by_user_id: null };
    this.certifications.push(row);
    return row;
  }
  async withdraw(tenant_id: string, user_id: string, now: Date) {
    let n = 0;
    for (const c of this.certifications) {
      if (c.tenant_id !== tenant_id || c.withdrawn_at !== null) continue;
      Object.assign(c, { withdrawn_at: now, withdrawn_by_user_id: user_id });
      n += 1;
    }
    return n;
  }
  async consentOf(user_id: string) {
    return this.consents.get(user_id) ?? null;
  }
  async setPhone(user_id: string, phone_e164: string, now: Date) {
    const e = this.consents.get(user_id);
    if (e !== undefined && e.phone_e164 === phone_e164) return e;
    const row: UserSmsConsentRow = { user_id, phone_e164, phone_verified_at: null, consented_at: null, consent_wording_version: null, consent_channel: null, revoked_at: null, created_at: e?.created_at ?? now, updated_at: now };
    this.consents.set(user_id, row);
    return row;
  }
  async markVerified(user_id: string, phone_e164: string, now: Date) {
    const e = this.consents.get(user_id);
    if (e === undefined || e.phone_e164 !== phone_e164) return false;
    e.phone_verified_at = now;
    return true;
  }
  async giveConsent(user_id: string, i: { wording_version: string; channel: string; now: Date }) {
    const e = this.consents.get(user_id);
    if (e === undefined || e.phone_verified_at === null) return false;
    Object.assign(e, { consented_at: i.now, consent_wording_version: i.wording_version, consent_channel: i.channel, revoked_at: null });
    return true;
  }
  async revokeConsent(user_id: string, now: Date) {
    const e = this.consents.get(user_id);
    if (e !== undefined && e.consented_at !== null && e.revoked_at === null) e.revoked_at = now;
  }
  async revokeConsentByPhone(phone_e164: string, now: Date) {
    let n = 0;
    for (const e of this.consents.values()) {
      if (e.phone_e164 !== phone_e164 || e.consented_at === null || e.revoked_at !== null) continue;
      e.revoked_at = now;
      n += 1;
    }
    return n;
  }
  async removeConsent(user_id: string) {
    this.consents.delete(user_id);
    this.codes = this.codes.filter((c) => c.user_id !== user_id);
  }
  async codeHistory(user_id: string, since: Date) {
    return this.codes.filter((c) => c.user_id === user_id && c.created_at >= since).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
  }
  async activeCode(user_id: string) {
    return [...this.codes].reverse().find((c) => c.user_id === user_id && c.status === 'ACTIVE') ?? null;
  }
  async createCode(i: { id: string; user_id: string; phone_hash: string; code_hash: string; expires_at: Date; now: Date }) {
    for (const c of this.codes) if (c.user_id === i.user_id && c.status === 'ACTIVE') c.status = 'SUPERSEDED';
    this.codes.push({ id: i.id, user_id: i.user_id, phone_hash: i.phone_hash, code_hash: i.code_hash, status: 'ACTIVE', attempts: 0, expires_at: i.expires_at, created_at: i.now, verified_at: null });
  }
  async withdrawCode(id: string) {
    const c = this.codes.find((x) => x.id === id);
    if (c?.status === 'ACTIVE') c.status = 'SUPERSEDED';
  }
  async recordCodeAttempt(i: { id: string; expected_attempts: number; outcome: string; now: Date }) {
    const c = this.codes.find((x) => x.id === i.id);
    if (c === undefined || c.status !== 'ACTIVE') return false;
    if (i.outcome !== 'EXPIRED' && c.attempts !== i.expected_attempts) return false;
    if (i.outcome !== 'EXPIRED') c.attempts += 1;
    if (i.outcome !== 'MISMATCH') c.status = i.outcome;
    if (i.outcome === 'VERIFIED') c.verified_at = i.now;
    return true;
  }
  async signerEmail(_t: string, signer_id: string) {
    return this.signerEmails.get(signer_id) ?? null;
  }
}

class FakeMessagingRepo {
  settings = new Map<string, RecipientMessagingRow>();
  deliveries: Array<NewDelivery & { id: string }> = [];
  ledger: LedgerAppend[] = [];
  optOuts = new Map<string, boolean>();
  challenges: Array<{ id: string; session_id: string; signer_id: string; phone_hash: string | null; phone_masked: string | null; code_hash: string; status: string; attempts: number; expires_at: Date; created_at: Date }> = [];
  private n = 0;
  setSetting(row: Partial<RecipientMessagingRow>) {
    this.settings.set(SIGNER, { signer_id: SIGNER, tenant_id: TENANT, envelope_id: ENVELOPE, delivery_channel: null, phone_e164: TYPED, timezone: null, sms_otp_required: false, updated_by: ADMIN, created_at: NOW, updated_at: NOW, ...row });
  }
  async settingFor(_t: string, signer_id: string) {
    return this.settings.get(signer_id) ?? null;
  }
  async settingsFor() {
    return [...this.settings.values()];
  }
  async upsertSetting(row: Omit<RecipientMessagingRow, 'created_at' | 'updated_at'>) {
    const r = { ...row, created_at: NOW, updated_at: NOW };
    this.settings.set(row.signer_id, r);
    return r;
  }
  async deleteSetting(_t: string, signer_id: string) {
    this.settings.delete(signer_id);
  }
  async deliveriesFor() {
    return [];
  }
  async envelopeAndSigner(_t: string, _e: string, signer_id?: string) {
    return { envelope: { status: 'DRAFT', created_by: ADMIN }, signer: signer_id === undefined ? null : { id: signer_id, recipient_kind: 'SIGNER' } };
  }
  async sentCounts() {
    return { last_hour: 0, last_day: 0 };
  }
  async recordDelivery(d: NewDelivery, ledger: LedgerAppend | null) {
    const id = d.id ?? `d${++this.n}`;
    this.deliveries.push({ ...d, id });
    if (ledger !== null) this.ledger.push(ledger);
    return { id, ledgered: ledger !== null };
  }
  async isOptedOut(hash: string, channel: string) {
    return this.optOuts.get(`${hash}:${channel}`) === true;
  }
  async setOptOut(hash: string, channel: string, opted_out: boolean) {
    this.optOuts.set(`${hash}:${channel}`, opted_out);
  }
  async emailOtpSetting() {
    return null;
  }
  async otpHistory() {
    return [];
  }
  async lockedChallengeCount() {
    return 0;
  }
  async isSessionVerified() {
    return false;
  }
  async activeChallenge(_t: string, session_id: string) {
    return [...this.challenges].reverse().find((c) => c.session_id === session_id && c.status === 'ACTIVE') ?? null;
  }
  async createChallenge(i: { id: string; session_id: string; signer_id: string; phone_hash?: string; phone_masked?: string; code_hash: string; expires_at: Date; now: Date }) {
    this.challenges.push({ id: i.id, session_id: i.session_id, signer_id: i.signer_id, phone_hash: i.phone_hash ?? null, phone_masked: i.phone_masked ?? null, code_hash: i.code_hash, status: 'ACTIVE', attempts: 0, expires_at: i.expires_at, created_at: i.now });
  }
  async withdrawChallenge(): Promise<void> {
    return undefined;
  }
  async appendLedger(_t: string, _e: string, _s: string | null, events: LedgerAppend[]) {
    this.ledger.push(...events);
    return true;
  }
}

class StubPort implements OutboundMessagingPort {
  readonly channels: ReadonlySet<'SMS' | 'WHATSAPP'> = new Set(['SMS'] as const);
  readonly sent: OutboundMessage[] = [];
  constructor(private readonly result: () => OutboundSendResult = () => ({ outcome: 'sent', provider: 'stub', provider_message_id: 'pm-1' })) {}
  canSend(): boolean {
    return true;
  }
  async send(m: OutboundMessage): Promise<OutboundSendResult> {
    this.sent.push(m);
    return this.result();
  }
}

const tenantsOf = (kind: string) => ({ findById: async () => ({ id: TENANT, kind, name: 'Acme', status: 'ACTIVE', is_active: true }) }) as unknown as TenantRepository;
const reader = (setting: boolean | null | Error): SignPlanFeatureReader => ({
  planFeatureEnabled: async () => setting === true,
  planFeatureSetting: async () => {
    if (setting instanceof Error) throw setting;
    return setting;
  },
});
const identityWith = (users: Record<string, { id: string; display_name?: string | null; is_active?: boolean }>) =>
  ({
    findUserByEmail: vi.fn(async (email: string) => {
      const u = users[email];
      return u === undefined ? null : { id: u.id, email, display_name: u.display_name ?? null, is_active: u.is_active ?? true };
    }),
    findUserById: vi.fn(async (id: string) => {
      const u = Object.values(users).find((x) => x.id === id);
      return u === undefined ? null : { id, email: 'x@acme.test', display_name: u.display_name ?? null, is_active: true };
    }),
  }) as unknown as IdentityRepository;

function world(opts: { kind?: string; gate?: SignFeatureGate; port?: OutboundMessagingPort | undefined; plan?: boolean | null; users?: Record<string, { id: string; display_name?: string | null; is_active?: boolean }> } = {}) {
  const consent = new FakeConsentRepo();
  const identity = identityWith(opts.users ?? { 'admin@acme.test': { id: ADMIN, display_name: 'Ada Admin' } });
  const facts = new SmsConsentFacts(consent as unknown as SignSmsConsentRepository, identity);
  const plan = new SignSmsPlanGate(tenantsOf(opts.kind ?? 'BUSINESS'), reader(opts.plan ?? null));
  const gate = opts.gate ?? LAUNCHED;
  const port = 'port' in opts ? opts.port : new StubPort();
  const policy = new SignSmsPolicy(plan, facts, gate, port);
  return { consent, identity, facts, plan, gate, port, policy };
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; status: number; reason: unknown; details: Record<string, unknown> }> {
  try {
    await p;
  } catch (e) {
    const err = e as AramoError;
    const details = (err.context?.details ?? {}) as Record<string, unknown>;
    return { code: err.code, status: err.statusCode, reason: details['reason'], details };
  }
  throw new Error('expected a refusal');
}

async function certifyNow(w: ReturnType<typeof world>) {
  await w.consent.certify({ id: 'c1', tenant_id: TENANT, user_id: ADMIN, wording_version: SMS_CERTIFICATION_WORDING_VERSION, now: NOW });
}

function consentUser(repo: FakeConsentRepo, over: Partial<UserSmsConsentRow> = {}) {
  repo.consents.set(USER, {
    user_id: USER,
    phone_e164: OWN,
    phone_verified_at: NOW,
    consented_at: NOW,
    consent_wording_version: SMS_CONSENT_WORDING_VERSION,
    consent_channel: 'WEB',
    revoked_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  });
}

// ── R-8 dark ─────────────────────────────────────────────────────────────────
describe('SMS-CONSENT-1 R-8 — dark', () => {
  it('the launch keys stay NOT_AVAILABLE', () => {
    expect(FEATURE_AVAILABILITY['sign.sms_delivery']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.sms_otp']).toBe('NOT_AVAILABLE');
  });

  it('available needs an SMS provider AND a launched key: false in the production composition', () => {
    expect(world({ gate: DARK, port: new DisabledOutboundMessaging() }).policy.available()).toBe(false);
    expect(world({ gate: DARK }).policy.available()).toBe(false);
    expect(world({ gate: LAUNCHED, port: new DisabledOutboundMessaging() }).policy.available()).toBe(false);
    expect(world({ gate: LAUNCHED, port: undefined }).policy.available()).toBe(false);
    expect(world({ gate: new SignFeatureGate({ ...FEATURE_AVAILABILITY, 'sign.sms_otp': 'AVAILABLE' }) }).policy.available()).toBe(true);
    expect(world({ gate: LAUNCHED }).policy.available()).toBe(true);
  });
});

// ── R-4 plan ─────────────────────────────────────────────────────────────────
describe('SMS-CONSENT-1 R-4 — signer SMS per plan', () => {
  it('an explicit plan setting wins; otherwise Business on, Personal off', () => {
    expect(smsEntitlementOf(false, 'BUSINESS')).toBe(false);
    expect(smsEntitlementOf(true, 'PERSONAL')).toBe(true);
    expect(smsEntitlementOf(null, 'BUSINESS')).toBe(true);
    expect(smsEntitlementOf(null, 'PERSONAL')).toBe(false);
    expect(smsEntitlementOf(null, null)).toBe(false);
  });

  it('the gate reads the plan for the asked key, then the kind; an unreadable store fails closed', async () => {
    const seen: string[] = [];
    const r: SignPlanFeatureReader = { planFeatureEnabled: async () => false, planFeatureSetting: async (_t, k) => (seen.push(k), null) };
    expect(await new SignSmsPlanGate(tenantsOf('BUSINESS'), r).entitled(TENANT, 'sign.sms_otp')).toBe(true);
    expect(seen).toEqual(['sign.sms_otp']);
    expect(await new SignSmsPlanGate(tenantsOf('BUSINESS'), reader(false)).entitled(TENANT, 'sign.sms_delivery')).toBe(false);
    expect(await new SignSmsPlanGate(tenantsOf('PERSONAL'), reader(null)).entitled(TENANT, 'sign.sms_delivery')).toBe(false);
    expect(await new SignSmsPlanGate(tenantsOf('BUSINESS'), reader(new Error('down'))).entitled(TENANT, 'sign.sms_delivery')).toBe(false);
  });
});

// ── The one rule: launch × plan × certification ─────────────────────────────
describe('SMS-CONSENT-1 — the sender gating (launch × plan × certification)', () => {
  const cases: Array<{ launched: boolean; kind: string; certified: boolean; on: boolean; required: boolean }> = [];
  for (const launched of [false, true]) for (const kind of ['BUSINESS', 'PERSONAL']) for (const certified of [false, true]) {
    const inPlan = launched && kind === 'BUSINESS';
    cases.push({ launched, kind, certified, on: inPlan && certified, required: inPlan });
  }

  it.each(cases)('launched=$launched $kind certified=$certified ⇒ on=$on required=$required', async ({ launched, kind, certified, on, required }) => {
    const w = world({ kind, gate: launched ? LAUNCHED : DARK });
    if (certified) await certifyNow(w);
    const s = await w.policy.featureState(TENANT);
    expect(s).toEqual({ sms_delivery: on, sms_otp: on, sms_certification: { required, certified } });
  });

  it('refusal order: not launched, then not in the plan, then not certified', async () => {
    expect(await world({ gate: DARK }).policy.refusalFor(TENANT, 'sign.sms_delivery')).toBe('feature_not_available');
    expect(await world({ kind: 'PERSONAL' }).policy.refusalFor(TENANT, 'sign.sms_delivery')).toBe('sms_not_in_plan');
    const w = world();
    expect(await w.policy.refusalFor(TENANT, 'sign.sms_otp')).toBe('sms_consent_not_certified');
    await certifyNow(w);
    expect(await w.policy.refusalFor(TENANT, 'sign.sms_otp')).toBeNull();
  });

  it('a certification under an older wording, or withdrawn, does not count', () => {
    const base = { withdrawn_at: null, wording_version: SMS_CERTIFICATION_WORDING_VERSION };
    expect(isCertificationCurrent(base)).toBe(true);
    expect(isCertificationCurrent({ ...base, wording_version: '2020-01-01' })).toBe(false);
    expect(isCertificationCurrent({ ...base, withdrawn_at: NOW })).toBe(false);
    expect(isCertificationCurrent(null)).toBe(false);
  });

  function context(w: ReturnType<typeof world>, kind = 'BUSINESS') {
    const tenants = { findById: vi.fn(async () => ({ id: TENANT, name: 'Acme', kind, is_active: true, status: 'ACTIVE' })), findSlugById: vi.fn(async () => 'acme'), findOrganizationNameById: vi.fn(async () => 'Acme') };
    const identity = { findUserById: vi.fn(async () => null), findMembership: vi.fn(async () => null), findRoleKeysForMembership: vi.fn(async () => []) };
    const personal = { authoringOpen: () => true, ensureFreeSubscription: vi.fn(async () => undefined) };
    const u = undefined;
    return new SenderContextService(tenants as never, identity as never, w.gate, personal as never, u, u, u, u, u, u, w.policy);
  }
  const AUTH = { sub: ADMIN, tenant_id: TENANT, scopes: ['sign:envelope:read'] } as unknown as AuthContextType;

  it('the sender context: features on only when certified; sms_certification says what is missing', async () => {
    const w = world();
    let v = await context(w).context(AUTH, 'r');
    expect(v.features).toMatchObject({ sms_delivery: false, sms_otp: false });
    expect(v.sms_certification).toEqual({ required: true, certified: false });
    await certifyNow(w);
    v = await context(w).context(AUTH, 'r');
    expect(v.features).toMatchObject({ sms_delivery: true, sms_otp: true });
    expect(v.sms_certification).toEqual({ required: true, certified: true });
  });

  it('the sender context: Personal never; dark reads nothing', async () => {
    const p = world({ kind: 'PERSONAL' });
    const pv = await context(p, 'PERSONAL').context(AUTH, 'r');
    expect(pv.features).toMatchObject({ sms_delivery: false, sms_otp: false });
    expect(pv.sms_certification).toEqual({ required: false, certified: false });
    const d = world({ gate: DARK });
    const dv = await context(d).context(AUTH, 'r');
    expect(dv.features).toMatchObject({ sms_delivery: false, sms_otp: false });
    expect(dv.sms_certification).toEqual({ required: false, certified: false });
    expect(d.consent.reads).toBe(0);
  });
});

// ── R-2 organization certification ───────────────────────────────────────────
describe('SMS-CONSENT-1 R-2 — organization certification', () => {
  const AUTH = { sub: ADMIN, tenant_id: TENANT };
  const service = (w: ReturnType<typeof world>) => new SmsCertificationService(w.policy, w.consent as unknown as SignSmsConsentRepository, w.identity);

  it('GET carries the current wording; dark ⇒ available false, required false', async () => {
    const v = await service(world({ gate: DARK })).view(TENANT);
    expect(v).toEqual({ available: false, required: false, certified: false, certified_at: null, certified_by_name: null, wording_version: SMS_CERTIFICATION_WORDING_VERSION, wording: SMS_CERTIFICATION_WORDING });
  });

  it('POST is refused while dark, on a Personal plan and with an outdated wording version', async () => {
    expect(await refusal(service(world({ gate: DARK })).certify(AUTH, { wording_version: SMS_CERTIFICATION_WORDING_VERSION }, 'r', NOW))).toMatchObject({ status: 403, reason: 'sms_not_available' });
    expect(await refusal(service(world({ kind: 'PERSONAL' })).certify(AUTH, { wording_version: SMS_CERTIFICATION_WORDING_VERSION }, 'r', NOW))).toMatchObject({
      code: 'ESIGN_FEATURE_NOT_AVAILABLE',
      status: 403,
      reason: 'sms_not_in_plan',
    });
    expect(await refusal(service(world()).certify(AUTH, { wording_version: '2020-01-01' }, 'r', NOW))).toMatchObject({ status: 400, reason: 'sms_wording_outdated' });
    expect(await refusal(service(world()).certify(AUTH, undefined, 'r', NOW))).toMatchObject({ status: 400, reason: 'sms_wording_outdated' });
  });

  it('POST records who and when (append-only, idempotent); DELETE withdraws', async () => {
    const w = world();
    const s = service(w);
    expect((await s.view(TENANT)).required).toBe(true);
    const v = await s.certify(AUTH, { wording_version: SMS_CERTIFICATION_WORDING_VERSION }, 'r', NOW);
    expect(v).toMatchObject({ available: true, required: true, certified: true, certified_at: NOW.toISOString(), certified_by_name: 'Ada Admin' });
    await s.certify(AUTH, { wording_version: SMS_CERTIFICATION_WORDING_VERSION }, 'r', new Date(NOW.getTime() + 60_000));
    expect(w.consent.certifications).toHaveLength(1);
    const later = new Date(NOW.getTime() + 3_600_000);
    const out = await s.withdraw(AUTH, later);
    expect(out).toMatchObject({ certified: false, certified_at: null, certified_by_name: null });
    expect(w.consent.certifications[0]).toMatchObject({ withdrawn_at: later, withdrawn_by_user_id: ADMIN });
    // A withdrawal is always accepted, even while dark.
    await expect(service(world({ gate: DARK })).withdraw(AUTH, later)).resolves.toMatchObject({ certified: false });
  });

  it('a current row under an older wording shows not certified', async () => {
    const w = world();
    w.consent.certifications.push({ id: 'old', tenant_id: TENANT, certified_by_user_id: ADMIN, certified_at: NOW, wording_version: '2020-01-01', withdrawn_at: null, withdrawn_by_user_id: null });
    expect(await service(w).view(TENANT)).toMatchObject({ certified: false, certified_at: null });
  });

  it('permissions: GET sign:envelope:read; POST and DELETE sign:settings:manage (owner / admin)', () => {
    const h = (n: string) => (SignSmsCertificationController.prototype as unknown as Record<string, object>)[n] ?? {};
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, h('get'))).toEqual(['sign:envelope:read']);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, h('certify'))).toEqual(['sign:settings:manage']);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, h('withdraw'))).toEqual(['sign:settings:manage']);
  });
});

// ── R-3 user consent ─────────────────────────────────────────────────────────
describe('SMS-CONSENT-1 R-3 — a user’s own number and consent', () => {
  const AUTH = { sub: USER };
  function setup(opts: { gate?: SignFeatureGate; result?: () => OutboundSendResult } = {}) {
    const port = new StubPort(opts.result);
    const w = world({ gate: opts.gate ?? LAUNCHED, port });
    const messaging = new FakeMessagingRepo();
    const svc = new UserSmsConsentService(w.policy, w.consent as unknown as SignSmsConsentRepository, messaging as unknown as SignMessagingRepository, w.facts, port);
    const lastCode = () => port.sent.at(-1)?.variables.code ?? '';
    return { w, port, messaging, svc, lastCode };
  }

  it('dark: GET says available false; sending and consenting are refused; turning off and removing are accepted', async () => {
    const { svc } = setup({ gate: DARK });
    expect(await svc.view(USER)).toEqual({ available: false, phone_masked: null, phone_verified: false, consented: false, consented_at: null, wording_version: SMS_CONSENT_WORDING_VERSION, wording: SMS_CONSENT_WORDING });
    expect(await refusal(svc.sendCode(AUTH, { phone_e164: OWN }, 'r', NOW))).toMatchObject({ status: 403, reason: 'sms_not_available' });
    expect(await refusal(svc.verify(AUTH, { code: '123456' }, 'r', NOW))).toMatchObject({ status: 403, reason: 'sms_not_available' });
    expect(await refusal(svc.setConsent(AUTH, { consented: true, wording_version: SMS_CONSENT_WORDING_VERSION, channel: 'WEB' }, 'r', NOW))).toMatchObject({ status: 403, reason: 'sms_not_available' });
    await expect(svc.setConsent(AUTH, { consented: false }, 'r', NOW)).resolves.toMatchObject({ consented: false });
    await expect(svc.remove(AUTH)).resolves.toMatchObject({ phone_masked: null });
  });

  it('verify the number with a texted code (signer code text, ends with STOP), then consent; then turn off; then remove', async () => {
    const { w, port, svc, lastCode } = setup();
    const sent = await svc.sendCode(AUTH, { phone_e164: ` ${OWN} ` }, 'r', NOW);
    expect(sent).toEqual({ sent: true, phone_masked: `+1${'•'.repeat(8)}99`, expires_in_seconds: 600, resend_after_seconds: 60 });
    expect(port.sent[0]).toMatchObject({ channel: 'SMS', purpose: 'OTP', variant: 'SIGNER_CODE', to_e164: OWN });
    expect(smsText(port.sent[0] as OutboundMessage)).toBe(signerSmsCodeText(lastCode(), 10));
    expect(w.consent.codes[0]?.code_hash).not.toContain(lastCode());

    expect(await refusal(svc.setConsent(AUTH, { consented: true, wording_version: SMS_CONSENT_WORDING_VERSION, channel: 'WEB' }, 'r', NOW))).toMatchObject({ status: 409, reason: 'sms_phone_not_verified' });
    const wrong = lastCode() === '000000' ? '111111' : '000000';
    expect(await refusal(svc.verify(AUTH, { code: wrong }, 'r', NOW))).toMatchObject({ status: 400, reason: 'sms_code_invalid', details: expect.objectContaining({ attempts_remaining: 4 }) });
    const verified = await svc.verify(AUTH, { code: lastCode() }, 'r', NOW);
    expect(verified).toMatchObject({ available: true, phone_verified: true, consented: false });

    expect(await refusal(svc.setConsent(AUTH, { consented: true, wording_version: '2020-01-01', channel: 'WEB' }, 'r', NOW))).toMatchObject({ reason: 'sms_wording_outdated' });
    expect(await refusal(svc.setConsent(AUTH, { consented: true, wording_version: SMS_CONSENT_WORDING_VERSION, channel: 'EMAIL' }, 'r', NOW))).toMatchObject({ reason: 'sms_channel_invalid' });
    expect(await refusal(svc.setConsent(AUTH, { consented: 'yes' }, 'r', NOW))).toMatchObject({ reason: 'sms_consent_invalid' });
    const on = await svc.setConsent(AUTH, { consented: true, wording_version: SMS_CONSENT_WORDING_VERSION, channel: 'APP' }, 'r', NOW);
    expect(on).toMatchObject({ consented: true, consented_at: NOW.toISOString(), phone_verified: true });
    expect(w.consent.consents.get(USER)).toMatchObject({ consent_channel: 'APP', consent_wording_version: SMS_CONSENT_WORDING_VERSION, revoked_at: null });

    const off = await svc.setConsent(AUTH, { consented: false }, 'r', new Date(NOW.getTime() + 1000));
    expect(off).toMatchObject({ consented: false, consented_at: null, phone_verified: true });
    const gone = await svc.remove(AUTH);
    expect(gone).toMatchObject({ phone_masked: null, phone_verified: false, consented: false });
    expect(w.consent.codes).toHaveLength(0);
  });

  it('a different number starts unverified and without consent', async () => {
    const { w, svc } = setup();
    consentUser(w.consent);
    await svc.sendCode(AUTH, { phone_e164: TYPED }, 'r', NOW);
    expect(await svc.view(USER)).toMatchObject({ phone_masked: `+1${'•'.repeat(8)}23`, phone_verified: false, consented: false });
  });

  it('a code for an earlier number does not verify the new one', async () => {
    const { w, svc, lastCode } = setup();
    await svc.sendCode(AUTH, { phone_e164: OWN }, 'r', NOW);
    const code = lastCode();
    await w.consent.setPhone(USER, TYPED, NOW);
    expect(await refusal(svc.verify(AUTH, { code }, 'r', NOW))).toMatchObject({ reason: 'sms_code_not_requested' });
  });

  it('refusals: invalid number, the 60 s gap, an expired code, an opted-out number, a failed send', async () => {
    const a = setup();
    expect(await refusal(a.svc.sendCode(AUTH, { phone_e164: '4155550123' }, 'r', NOW))).toMatchObject({ status: 400, reason: 'sms_phone_invalid' });
    await a.svc.sendCode(AUTH, { phone_e164: OWN }, 'r', NOW);
    expect(await refusal(a.svc.sendCode(AUTH, { phone_e164: OWN }, 'r', new Date(NOW.getTime() + 30_000)))).toMatchObject({
      status: 429,
      reason: 'sms_code_rate_limited',
      details: expect.objectContaining({ retry_after_seconds: 30 }),
    });
    expect(await refusal(a.svc.verify(AUTH, { code: a.lastCode() }, 'r', new Date(NOW.getTime() + 11 * 60_000)))).toMatchObject({ reason: 'sms_code_expired' });

    const b = setup();
    b.messaging.optOuts.set(`${phoneHash(OWN)}:SMS`, true);
    expect(await refusal(b.svc.sendCode(AUTH, { phone_e164: OWN }, 'r', NOW))).toMatchObject({ reason: 'sms_phone_opted_out' });

    const c = setup({ result: () => ({ outcome: 'failed', provider: 'stub', error_code: 'boom' }) });
    expect(await refusal(c.svc.sendCode(AUTH, { phone_e164: OWN }, 'r', NOW))).toMatchObject({ status: 503, reason: 'sms_code_not_sent' });
    expect(c.w.consent.codes[0]?.status).toBe('SUPERSEDED');

    const d = setup({ result: () => ({ outcome: 'opted_out', provider: 'stub' }) });
    expect(await refusal(d.svc.sendCode(AUTH, { phone_e164: OWN }, 'r', NOW))).toMatchObject({ reason: 'sms_phone_opted_out' });
    expect(d.messaging.optOuts.get(`${phoneHash(OWN)}:SMS`)).toBe(true);
  });

  it('a consent under an older wording no longer counts', () => {
    const row = { phone_verified_at: NOW, consented_at: NOW, revoked_at: null, consent_wording_version: SMS_CONSENT_WORDING_VERSION };
    expect(isConsentActive(row)).toBe(true);
    expect(isConsentActive({ ...row, consent_wording_version: '2020-01-01' })).toBe(false);
    expect(isConsentActive({ ...row, revoked_at: NOW })).toBe(false);
    expect(isConsentActive({ ...row, phone_verified_at: null })).toBe(false);
  });

  it('every route is the per-user session boundary (no Sign role scope)', () => {
    for (const n of ['get', 'phone', 'verify', 'put', 'remove']) {
      const h = (SignUserSmsConsentController.prototype as unknown as Record<string, object>)[n] ?? {};
      expect(Reflect.getMetadata(GUARDS_METADATA, h)).toEqual([JwtAuthGuard, EsignSenderConsumerGuard]);
    }
  });
});

// ── Recipient messaging refusals ─────────────────────────────────────────────
describe('SMS-CONSENT-1 — recipient messaging writes', () => {
  const auth = { sub: ADMIN, tenant_id: TENANT, scopes: [] } as unknown as AuthContextType;
  function setup(kind = 'BUSINESS') {
    const w = world({ kind });
    const repo = new FakeMessagingRepo();
    const messaging = new SignMessagingService(repo as unknown as SignMessagingRepository, w.port as OutboundMessagingPort, w.gate, undefined, undefined, NO_QUIET, w.facts);
    const context = { assertCanAuthor: vi.fn(async () => undefined) } as unknown as SenderContextService;
    const envelopes = { assertMayChange: vi.fn(async () => undefined), assertVisible: vi.fn(async () => undefined) } as unknown as SenderEnvelopeService;
    const svc = new SenderMessagingService(repo as unknown as SignMessagingRepository, messaging, context, envelopes, w.gate, undefined, w.policy);
    return { w, repo, svc };
  }

  it('a Personal plan: 403 sms_not_in_plan for SMS delivery and the SMS code', async () => {
    const { svc } = setup('PERSONAL');
    expect(await refusal(svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', phone_e164: TYPED }, 'r'))).toMatchObject({
      code: 'ESIGN_FEATURE_NOT_AVAILABLE',
      status: 403,
      reason: 'sms_not_in_plan',
      details: expect.objectContaining({ feature_key: 'sign.sms_delivery' }),
    });
    expect(await refusal(svc.put(auth, ENVELOPE, SIGNER, { sms_otp_required: true, phone_e164: TYPED }, 'r'))).toMatchObject({ reason: 'sms_not_in_plan', details: expect.objectContaining({ feature_key: 'sign.sms_otp' }) });
  });

  it('Business, not certified: 403 sms_consent_not_certified; certified: stored; GET features follow', async () => {
    const { w, repo, svc } = setup();
    expect(await refusal(svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', sms_otp_required: true, phone_e164: TYPED }, 'r'))).toMatchObject({ status: 403, reason: 'sms_consent_not_certified' });
    expect(repo.settings.size).toBe(0);
    expect((await svc.get(auth, ENVELOPE, 'r')).features).toMatchObject({ sms_delivery: false, sms_otp: false });
    await certifyNow(w);
    await expect(svc.put(auth, ENVELOPE, SIGNER, { delivery_channel: 'SMS', sms_otp_required: true, phone_e164: TYPED }, 'r')).resolves.toMatchObject({ delivery_channel: 'SMS', sms_otp_required: true });
    expect((await svc.get(auth, ENVELOPE, 'r')).features).toMatchObject({ sms_delivery: true, sms_otp: true });
  });
});

// ── R-5 delivery preference and no leak ──────────────────────────────────────
describe('SMS-CONSENT-1 R-5 — the signer’s own consented number first, never told to the sender', () => {
  const link = { tenant_id: TENANT, envelope_id: ENVELOPE, signer_id: SIGNER, purpose: 'INVITATION' as const, signing_url: 'https://sign.example/s/RAW' };
  const typedMask = `+1${'•'.repeat(8)}23`;
  const ownMask = `+1${'•'.repeat(8)}99`;

  function setup(opts: { certified?: boolean; consent?: Partial<UserSmsConsentRow> | null } = {}) {
    const w = world({ users: { 'signer@acme.test': { id: USER }, 'admin@acme.test': { id: ADMIN, display_name: 'Ada Admin' } } });
    w.consent.signerEmails.set(SIGNER, 'Signer@Acme.test');
    if (opts.consent !== null) consentUser(w.consent, opts.consent ?? {});
    const repo = new FakeMessagingRepo();
    repo.setSetting({ delivery_channel: 'SMS', sms_otp_required: true });
    const port = w.port as StubPort;
    const messaging = new SignMessagingService(repo as unknown as SignMessagingRepository, port, w.gate, undefined, undefined, NO_QUIET, w.facts);
    return { w, repo, port, messaging };
  }

  // A1 — the evidence names what was really texted: the label, never the typed number's mask.
  it('the link goes to the consented number; every sender-visible record says the signer’s own verified number (A1)', async () => {
    const { repo, port, messaging } = setup();
    await messaging.deliverSigningLink(link);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.to_e164).toBe(OWN);
    expect(repo.deliveries[0]).toMatchObject({ status: 'SENT', phone_masked: SIGNER_VERIFIED_NUMBER_LABEL, phone_hash: phoneHash(OWN) });
    expect(repo.ledger[0]).toMatchObject({ event_type: 'SIGNER_MESSAGE_SENT', payload: expect.objectContaining({ phone: SIGNER_VERIFIED_NUMBER_LABEL, destination: 'SIGNER_VERIFIED_NUMBER' }) });
    expect(JSON.stringify(repo.ledger)).not.toContain(typedMask);
    expect(JSON.stringify(repo.deliveries)).not.toContain(typedMask);
    expect(JSON.stringify(repo.ledger)).not.toContain(ownMask);
    expect(JSON.stringify(repo.deliveries)).not.toContain(ownMask);
  });

  it('no consented number: the typed number, only while the organization is certified', async () => {
    const off = setup({ consent: null });
    await off.messaging.deliverSigningLink(link);
    expect(off.port.sent).toHaveLength(0);
    expect(off.repo.deliveries).toHaveLength(0);
    const on = setup({ consent: null });
    await certifyNow(on.w);
    await on.messaging.deliverSigningLink(link);
    expect(on.port.sent[0]?.to_e164).toBe(TYPED);
  });

  it('a revoked consent, an older wording or an inactive user falls back to the typed number', async () => {
    for (const consent of [{ revoked_at: NOW }, { consent_wording_version: '2020-01-01' }, { phone_verified_at: null, consented_at: null }]) {
      const s = setup({ consent });
      await certifyNow(s.w);
      await s.messaging.deliverSigningLink(link);
      expect(s.port.sent[0]?.to_e164).toBe(TYPED);
    }
    const inactive = setup();
    (inactive.w.identity.findUserByEmail as ReturnType<typeof vi.fn>).mockResolvedValue({ id: USER, email: 'signer@acme.test', display_name: null, is_active: false });
    await certifyNow(inactive.w);
    await inactive.messaging.deliverSigningLink(link);
    expect(inactive.port.sent[0]?.to_e164).toBe(TYPED);
  });

  it('STOP from the consented number revokes the consent; opt-outs are checked on the destination', async () => {
    const { w, repo, port, messaging } = setup();
    expect(await messaging.inboundMessage('SMS', OWN, 'STOP', NOW)).toBe('OPT_OUT');
    expect(w.consent.consents.get(USER)?.revoked_at).toEqual(NOW);
    // Not certified and no active consent any more ⇒ nothing is texted.
    await messaging.deliverSigningLink(link);
    expect(port.sent).toHaveLength(0);
    // START never restores the consent.
    await messaging.inboundMessage('SMS', OWN, 'START', NOW);
    expect(w.consent.consents.get(USER)?.revoked_at).toEqual(NOW);
    // An opted-out consented number is suppressed (never texted).
    const s = setup();
    s.repo.optOuts.set(`${phoneHash(OWN)}:SMS`, true);
    await s.messaging.deliverSigningLink(link);
    expect(s.port.sent).toHaveLength(0);
    expect(s.repo.deliveries[0]).toMatchObject({ status: 'SUPPRESSED', suppressed_reason: 'opted_out', phone_masked: SIGNER_VERIFIED_NUMBER_LABEL });
    expect(repo.deliveries).toHaveLength(0);
  });

  it('a provider opt-out on the consented number revokes the consent too', async () => {
    const w = world({ users: { 'signer@acme.test': { id: USER } }, port: new StubPort(() => ({ outcome: 'opted_out', provider: 'stub' })) });
    w.consent.signerEmails.set(SIGNER, 'signer@acme.test');
    consentUser(w.consent);
    const repo = new FakeMessagingRepo();
    repo.setSetting({ delivery_channel: 'SMS' });
    await new SignMessagingService(repo as unknown as SignMessagingRepository, w.port as OutboundMessagingPort, w.gate, undefined, undefined, NO_QUIET, w.facts).deliverSigningLink(link);
    expect(w.consent.consents.get(USER)?.revoked_at).not.toBeNull();
  });

  it('the SMS code: sent to the consented number with the signer code text; the signer sees that number, the evidence the label (A1)', async () => {
    const { repo, port, messaging, w } = setup();
    const otp = new RecipientOtpService(repo as unknown as SignMessagingRepository, messaging, undefined, w.facts);
    const ctx: SessionContext = { session_id: SESSION, tenant_id: TENANT, envelope_id: ENVELOPE, signer_id: SIGNER };
    expect(await otp.status(ctx)).toMatchObject({ required: true, phone: ownMask });
    const sent = await otp.send(ctx, 'r', NOW);
    expect(sent).toMatchObject({ sent: true, phone: ownMask });
    expect(port.sent[0]).toMatchObject({ to_e164: OWN, purpose: 'OTP', variant: 'SIGNER_CODE' });
    expect(smsText(port.sent[0] as OutboundMessage).endsWith('Reply STOP to opt out.')).toBe(true);
    expect(repo.challenges[0]).toMatchObject({ phone_masked: SIGNER_VERIFIED_NUMBER_LABEL, phone_hash: phoneHash(OWN) });
    expect(repo.ledger.find((e) => e.event_type === 'RECIPIENT_OTP_SENT')?.payload).toMatchObject({ phone: SIGNER_VERIFIED_NUMBER_LABEL });
    expect(repo.deliveries[0]).toMatchObject({ phone_masked: SIGNER_VERIFIED_NUMBER_LABEL });
    expect(JSON.stringify(repo.ledger)).not.toContain(typedMask);
    expect(JSON.stringify(repo.ledger)).not.toContain(ownMask);
  });

  it('without a consented number the code goes to the typed number', async () => {
    const { repo, port, messaging, w } = setup({ consent: null });
    const otp = new RecipientOtpService(repo as unknown as SignMessagingRepository, messaging, undefined, w.facts);
    await otp.send({ session_id: SESSION, tenant_id: TENANT, envelope_id: ENVELOPE, signer_id: SIGNER }, 'r', NOW);
    expect(port.sent[0]?.to_e164).toBe(TYPED);
  });
});

// ── R-6 texts ────────────────────────────────────────────────────────────────
describe('SMS-CONSENT-1 R-6 — the texts', () => {
  it('the signer code text ends with STOP; the sender step-up text is unchanged', () => {
    const base = { channel: 'SMS' as const, purpose: 'OTP' as const, to_e164: TYPED, reference: 'r', variables: { code: '123456', ttl_minutes: 10 } };
    expect(smsText({ ...base, variant: 'SIGNER_CODE' })).toBe('Your Aramo Sign verification code is 123456. It expires in 10 minutes. Do not share it. Reply STOP to opt out.');
    expect(smsText(base)).toBe('Your Aramo Sign verification code is 123456. It expires in 10 minutes. Do not share it.');
  });
});

// SMS-CONSENT-1 A1 — account deletion and privacy erasure remove the person's SMS consent and codes.
describe('SMS-CONSENT-1 A1 — erasure', () => {
  it('removeAllForUser deletes the SMS consent and codes with the other user data and counts them', async () => {
    const del = (count: number) => vi.fn(async () => ({ count }));
    const tx = {
      signUserProfile: { deleteMany: del(1) },
      signUserSettings: { deleteMany: del(1) },
      signAppIssueReport: { deleteMany: del(0) },
      signUserFavorite: { deleteMany: del(0) },
      signUserFolder: { deleteMany: del(2) },
      signUserSmsConsent: { deleteMany: del(1) },
      signUserSmsCode: { deleteMany: del(3) },
    };
    const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    const counts = await new SignUserProfileRepository(prisma as never).removeAllForUser(TENANT, USER);
    expect(counts).toMatchObject({ folders: 2, sms_consents: 1, sms_codes: 3 });
    expect(tx.signUserSmsConsent.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } });
    expect(tx.signUserSmsCode.deleteMany).toHaveBeenCalledWith({ where: { user_id: USER } });
  });
});

