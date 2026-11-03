import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { AramoError } from '@aramo/common';
import { nativeSignupRequestHash, type NativeIntegrityCheck, type NativeIntegrityResult, type PersonalSignupRow, type RobotCheckPort } from '@aramo/identity';
import { LEGAL_DOCUMENTS, type LegalDocumentVersion } from '@aramo/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LegalTextSource } from '../app/signup/legal-text.source.js';
import { PersonalSignupController } from '../app/signup/personal-signup.controller.js';
import { PersonalSignupService, type PersonalTermsText } from '../app/signup/personal-signup.service.js';
import { SignupBudget } from '../app/signup/sign-signup.service.js';

// Aramo-Sign-Mobile-Amendment-M-A11 (LOCKED) §2 / §2.1 / §2.2 / §5 — the native Personal
// signup on the server: `start` from client android (integrity check bound to the
// recomputed requestHash), the terms text read, and `complete`'s key/version/sha256
// binding with the acceptance origin. The service runs with in-memory collaborators.

const REPO_ROOT = resolve(__dirname, '../../../..');
const NOW = new Date('2026-11-03T15:00:00Z');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const doc = (key: string, version: string) => LEGAL_DOCUMENTS.find((d) => d.key === key && d.version === version)!;
const TOS = doc('sign.terms_of_service', '2.0');
const PRIVACY = doc('aramo.privacy_notice', '1.0');
const AUP = doc('aramo.acceptable_use_policy', '1.0');
const ACCEPT_ANDROID = [TOS, PRIVACY, AUP].map((d) => ({ key: d.key, version: d.version, sha256: d.sha256 }));

class FakeIntegrity implements NativeIntegrityCheck {
  calls: { token: string | null; request_hash: string }[] = [];
  /** The hash the (fake) Google payload carries; null = no token was minted. */
  boundHash: string | null = null;
  result: NativeIntegrityResult | null = null;
  async verify(input: { token: string | null; request_hash: string }): Promise<NativeIntegrityResult> {
    this.calls.push({ token: input.token, request_hash: input.request_hash });
    if (this.result !== null) return this.result;
    if (input.token === null) return { verdict: 'fail', reason: 'token_missing' };
    return input.request_hash === this.boundHash ? { verdict: 'pass', reason: 'ok' } : { verdict: 'fail', reason: 'request_hash_mismatch' };
  }
}

function row(over: Partial<PersonalSignupRow> = {}): PersonalSignupRow {
  return {
    id: '01900000-0000-7000-8000-0000000a1100',
    email: 'pat.person@gmail.com',
    canonical_email: 'patperson@gmail.com',
    display_name: 'Pat Person',
    phone_e164: '+12025550101',
    declared_residence: 'US',
    ip: null,
    ip_country: null,
    phone_region: 'US',
    network_kind: 'unknown',
    geo_evidence: null,
    email_otp_hash: null,
    email_otp_expires_at: null,
    email_otp_attempts: 0,
    email_otp_sent_count: 1,
    email_otp_last_sent_at: null,
    email_verified_at: NOW,
    phone_otp_hash: null,
    phone_otp_expires_at: null,
    phone_otp_attempts: 0,
    phone_otp_sent_count: 0,
    phone_otp_last_sent_at: null,
    phone_verified_at: null,
    risk_points: 0,
    risk_signals: [],
    decision: 'allow',
    invite_id: null,
    accepted_documents: null,
    accepted_ip: null,
    accepted_at: null,
    status: 'EMAIL_VERIFIED',
    failure_code: null,
    tenant_id: null,
    owner_user_id: null,
    provisioned_at: null,
    expires_at: new Date(NOW.getTime() + 24 * 3600 * 1000),
    created_at: NOW,
    updated_at: NOW,
    ...over,
  };
}

function harness(opts: { registry?: readonly LegalDocumentVersion[]; texts?: LegalTextSource; signup?: PersonalSignupRow } = {}) {
  const created: Record<string, unknown>[] = [];
  const signup = opts.signup ?? row();
  const requests = {
    countStartsSince: vi.fn(async () => 0),
    findResumableLapsed: vi.fn(async () => null),
    countByIpSince: vi.fn(async () => 0),
    gmailAliasOfExisting: vi.fn(async () => false),
    phoneUsedByAnother: vi.fn(async () => false),
    create: vi.fn(async (input: Record<string, unknown>) => {
      created.push(input);
      return row({ id: '01900000-0000-7000-8000-0000000a1101', status: String(input['status']), decision: String(input['decision']) });
    }),
    setEmailOtp: vi.fn(async () => undefined),
    findById: vi.fn(async () => signup),
    claimForProvisioning: vi.fn(async () => true),
    claimForProvisioningWithinCap: vi.fn(async () => 'claimed'),
    completeProvisioning: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
  };
  const identity = {
    findUserByEmail: vi.fn(async () => null),
    resolveRoleIdsByKeys: vi.fn(async () => ['role-owner']),
    createFederatedOwnerNoSub: vi.fn(async () => ({ user: { id: 'user-1' } })),
  };
  const tenantSvc = { provisionTenant: vi.fn(async () => ({ id: 'tenant-1' })), deactivateTenant: vi.fn(async () => undefined) };
  const entitlements = { grantCapabilities: vi.fn(async () => undefined) };
  const idpPolicy = { enrollEnforcedTenantPinned: vi.fn(async () => undefined) };
  const acceptances = { record: vi.fn(async () => undefined) };
  const mailer = { send: vi.fn(async () => ({ message_id: 'm' })) };
  const geo = { lookup: vi.fn(), countryOf: vi.fn(), networkKind: vi.fn() };
  const sms = { configured: false, send: vi.fn() };
  const robot: RobotCheckPort & { verify: ReturnType<typeof vi.fn> } = { verify: vi.fn(async () => ({ verdict: 'pass' as const })) };
  const integrity = new FakeIntegrity();
  const texts = opts.texts ?? new LegalTextSource(REPO_ROOT);
  const svc = new PersonalSignupService(
    requests as never,
    identity as never,
    {} as never,
    {} as never,
    tenantSvc as never,
    entitlements as never,
    idpPolicy as never,
    acceptances as never,
    new SignupBudget(),
    mailer as never,
    geo as never,
    sms as never,
    robot,
    integrity,
    texts,
    opts.registry ?? LEGAL_DOCUMENTS,
  );
  return { svc, requests, identity, acceptances, robot, integrity, created };
}

const ANDROID = {
  client: 'android',
  name: 'Pat Person',
  email: 'pat.person@gmail.com',
  phone: '+12025550101',
  residence: 'US',
  invite_code: null,
  hp: '',
  elapsed_ms: 20_000,
};

async function refusalOf(p: Promise<unknown>): Promise<{ code: string; status: number; reason: unknown; details: Record<string, unknown> | undefined }> {
  try {
    await p;
  } catch (err) {
    if (!(err instanceof AramoError)) throw err;
    const details = err.context.details as Record<string, unknown> | undefined;
    return { code: err.code, status: err.statusCode, reason: details?.['reason'], details };
  }
  throw new Error('expected a refusal');
}

beforeEach(() => vi.stubEnv('SIGN_PERSONAL_SIGNUP_MODE', 'open'));
afterEach(() => vi.unstubAllEnvs());

describe('start — client android (§2.1)', () => {
  it('passes when the token is bound to the hash the server recomputes from the received body; Turnstile is not consulted', async () => {
    const h = harness();
    h.integrity.boundHash = nativeSignupRequestHash(ANDROID);
    const out = await h.svc.start({ ...ANDROID, integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW });
    expect(out.signup_id).toBe('01900000-0000-7000-8000-0000000a1101');
    expect(h.integrity.calls).toEqual([{ token: 'tok', request_hash: nativeSignupRequestHash(ANDROID) }]);
    // The canonical array of the contract, recomputed independently here.
    expect(h.integrity.calls[0]!.request_hash).toBe(sha(Buffer.from(JSON.stringify(['android', 'Pat Person', 'pat.person@gmail.com', '+12025550101', 'US', null, '', 20000]), 'utf8')));
    expect(h.robot.verify).not.toHaveBeenCalled();
    // Not refused (the unknown network country of this harness adds points: step_up).
    expect(h.created[0]).toMatchObject({ status: 'PENDING' });
    expect(h.created[0]!['decision']).not.toBe('refuse');
  });

  it('hashes the values exactly as received — before trim / lower-case normalization', async () => {
    const h = harness();
    const raw = { ...ANDROID, email: '  Pat.Person@Gmail.com ', name: ' Pat  Person ' };
    h.integrity.boundHash = nativeSignupRequestHash(raw);
    await h.svc.start({ ...raw, integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW });
    expect(h.integrity.calls[0]!.request_hash).toBe(nativeSignupRequestHash(raw));
    expect(h.integrity.calls[0]!.request_hash).not.toBe(nativeSignupRequestHash(ANDROID));
    expect(h.created[0]).toMatchObject({ email: 'pat.person@gmail.com', status: 'PENDING' });
  });

  it('absent invite_code hashes as null', async () => {
    const h = harness();
    const noInvite: Record<string, unknown> = { ...ANDROID };
    delete noInvite['invite_code'];
    h.integrity.boundHash = nativeSignupRequestHash(ANDROID);
    await h.svc.start({ ...noInvite, integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW });
    expect(h.integrity.calls[0]!.request_hash).toBe(nativeSignupRequestHash(ANDROID));
  });

  it('hash mismatch (a body that differs from the one the token was minted for) → fail → refused, stored as robot_check_failed', async () => {
    const h = harness();
    h.integrity.boundHash = nativeSignupRequestHash(ANDROID);
    const r = await refusalOf(h.svc.start({ ...ANDROID, phone: '+12025550199', integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW }));
    expect(r).toMatchObject({ code: 'VALIDATION_ERROR', reason: 'personal_signup_refused' });
    expect(h.created[0]).toMatchObject({ status: 'REFUSED', decision: 'refuse' });
    expect((h.created[0]!['risk_signals'] as { key: string }[]).map((s) => s.key)).toContain('robot_check_failed');
  });

  it('a missing token is a fail (refused); unavailable is refused without creating a signup (fail closed)', async () => {
    const h = harness();
    h.integrity.boundHash = nativeSignupRequestHash(ANDROID);
    expect((await refusalOf(h.svc.start({ ...ANDROID, ip: 'unknown', request_id: 'r', now: NOW }))).reason).toBe('personal_signup_refused');
    expect(h.integrity.calls[0]!.token).toBeNull();

    const u = harness();
    u.integrity.result = { verdict: 'unavailable', reason: 'decode_unavailable' };
    expect((await refusalOf(u.svc.start({ ...ANDROID, integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW }))).reason).toBe('personal_signup_refused');
    expect(u.requests.create).not.toHaveBeenCalled();
  });

  it('a robot_token from the app is ignored: only the integrity check decides', async () => {
    const h = harness();
    h.integrity.result = { verdict: 'fail', reason: 'app_not_recognized' };
    expect((await refusalOf(h.svc.start({ ...ANDROID, robot_token: 'turnstile-ok', integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW }))).reason).toBe(
      'personal_signup_refused',
    );
    expect(h.robot.verify).not.toHaveBeenCalled();
  });

  it.each([['20000'], [20_000.5], [null], [undefined], [Number.NaN]])('elapsed_ms %s (not a JSON integer) → VALIDATION_ERROR before any check', async (elapsed) => {
    const h = harness();
    const r = await refusalOf(h.svc.start({ ...ANDROID, elapsed_ms: elapsed, integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW }));
    expect(r).toMatchObject({ code: 'VALIDATION_ERROR', status: 400, details: { field: 'elapsed_ms' } });
    expect(h.integrity.calls).toHaveLength(0);
  });

  it.each([['ios'], ['Android'], [''], [null], [1]])('client %s → VALIDATION_ERROR', async (client) => {
    const h = harness();
    const r = await refusalOf(h.svc.start({ ...ANDROID, client, integrity_token: 'tok', ip: 'unknown', request_id: 'r', now: NOW }));
    expect(r).toMatchObject({ code: 'VALIDATION_ERROR', details: { field: 'client' } });
    expect(h.integrity.calls).toHaveLength(0);
    expect(h.robot.verify).not.toHaveBeenCalled();
  });

  it('web (no client, or client web) is unchanged: Turnstile decides and the integrity check is never called', async () => {
    for (const client of [undefined, 'web']) {
      const h = harness();
      const body = { name: 'Pat Person', email: 'pat.person@gmail.com', phone: '+12025550101', residence: 'US', robot_token: 'ts', elapsed_ms: 20_000, ...(client === undefined ? {} : { client }) };
      await h.svc.start({ ...body, integrity_token: 'ignored', ip: 'unknown', request_id: 'r', now: NOW });
      expect(h.robot.verify).toHaveBeenCalledWith('ts', 'unknown');
      expect(h.integrity.calls).toHaveLength(0);
    }
  });
});

describe('terms text (§2.2)', () => {
  it('serves each currently effective Personal document with the registry sha256; the text bytes hash to it', () => {
    const { svc } = harness();
    const terms = svc.currentTerms(NOW)!;
    expect(terms.map((t) => `${t.key}@${t.version}`)).toEqual(['sign.terms_of_service@2.0', 'aramo.privacy_notice@1.0', 'aramo.acceptable_use_policy@1.0']);
    for (const t of terms) {
      const out = svc.termsText(t.key, t.version, NOW) as PersonalTermsText;
      expect(out).toMatchObject({ key: t.key, version: t.version, sha256: t.sha256 });
      expect(sha(Buffer.from(out.text, 'utf8'))).toBe(t.sha256);
      expect(out.effective_at).toBe(new Date(LEGAL_DOCUMENTS.find((d) => d.key === t.key && d.version === t.version)!.effective_from!).toISOString());
    }
    expect(svc.termsText('sign.terms_of_service', '2.0', NOW)!.effective_at).toBe('2026-11-02T17:00:00.000Z');
  });

  it.each([
    ['the superseded Personal Terms', 'sign.personal_terms_of_service', '1.0'],
    ['a DRAFT', 'sign.terms_of_service', '0.1.1'],
    ['a Business-only document', 'sign.privacy_policy', '0.1.0'],
    ['an unknown key', 'aramo.nothing', '1.0'],
    ['an unknown version', 'aramo.privacy_notice', '9.9'],
  ])('%s → null (404)', (_l, key, version) => {
    expect(harness().svc.termsText(key, version, NOW)).toBeNull();
  });

  it('an approved version that is only upcoming is not served; once effective, its predecessor is not', () => {
    const next: LegalDocumentVersion = { ...PRIVACY, version: '1.1', effective_from: '2026-11-04T00:00:00Z', url: 'https://sign.aramo.ai/legal/privacy/1.1' };
    const { svc } = harness({ registry: [...LEGAL_DOCUMENTS, next] });
    expect(svc.termsText('aramo.privacy_notice', '1.1', NOW)).toBeNull();
    expect(svc.termsText('aramo.privacy_notice', '1.0', NOW)).not.toBeNull();
    expect(svc.termsText('aramo.privacy_notice', '1.0', new Date('2026-11-04T00:00:00Z'))).toBeNull();
  });

  it('the text is the gate: missing or changed bytes are never served', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma11-legal-'));
    try {
      const file = join(dir, PRIVACY.path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, 'not the approved text');
      const { svc } = harness({ texts: new LegalTextSource(dir) });
      expect(svc.termsText('aramo.privacy_notice', '1.0', NOW)).toBeNull(); // sha256 mismatch
      expect(svc.termsText('aramo.acceptable_use_policy', '1.0', NOW)).toBeNull(); // file missing
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the controller answers 404 legal_document_not_found, and 404 while signup is off', () => {
    const ctl = new PersonalSignupController(harness().svc);
    let caught: unknown;
    try {
      ctl.termsText('r', 'sign.terms_of_service', '0.1.1');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AramoError);
    expect((caught as AramoError).statusCode).toBe(404);
    expect((caught as AramoError).context.details).toEqual({ reason: 'legal_document_not_found' });
    expect(ctl.termsText('r', 'aramo.privacy_notice', '1.0').sha256).toBe(PRIVACY.sha256);

    vi.stubEnv('SIGN_PERSONAL_SIGNUP_MODE', 'off');
    expect(() => ctl.termsText('r', 'aramo.privacy_notice', '1.0')).toThrow(AramoError);
  });
});

describe('complete — android acceptance binding (§2.2)', () => {
  const nothingRecorded = (h: ReturnType<typeof harness>) => {
    expect(h.requests.claimForProvisioning).not.toHaveBeenCalled();
    expect(h.acceptances.record).not.toHaveBeenCalled();
    expect(h.requests.completeProvisioning).not.toHaveBeenCalled();
  };

  it('an exact key + version + sha256 entry for every effective document completes; each acceptance records its hash and origin', async () => {
    const h = harness();
    const out = await h.svc.complete({ signup_id: row().id, client: 'android', accept: ACCEPT_ANDROID, ip: '203.0.113.9', user_agent: 'okhttp/4.12.0', request_id: 'r', now: NOW });
    expect(out.status).toBe('PROVISIONED');
    expect(h.acceptances.record).toHaveBeenCalledTimes(3);
    const recorded = h.acceptances.record.mock.calls.map((c) => (c as unknown as [{ document: LegalDocumentVersion; origin?: unknown }])[0]);
    expect(recorded.map((r) => `${r.document.key}@${r.document.version}#${r.document.sha256}`)).toEqual(ACCEPT_ANDROID.map((a) => `${a.key}@${a.version}#${a.sha256}`));
    for (const r of recorded) expect(r.origin).toEqual({ ip: '203.0.113.9', user_agent: 'okhttp/4.12.0' });
    expect(h.requests.completeProvisioning).toHaveBeenCalledWith(expect.objectContaining({ client: 'android' }));
    const claimed = (h.requests.claimForProvisioning.mock.calls[0] as unknown as [string, { documents: unknown }])[1];
    expect(claimed.documents).toEqual(ACCEPT_ANDROID);
  });

  it('entry order does not matter', async () => {
    const h = harness();
    expect((await h.svc.complete({ signup_id: row().id, client: 'android', accept: [...ACCEPT_ANDROID].reverse(), ip: 'unknown', request_id: 'r', now: NOW })).status).toBe('PROVISIONED');
  });

  it.each([
    ['a missing entry', ACCEPT_ANDROID.slice(0, 2)],
    ['no entries', []],
    ['no accept array', undefined],
    ['an entry without sha256', [ACCEPT_ANDROID[0], ACCEPT_ANDROID[1], { key: AUP.key, version: AUP.version }]],
    ['a mismatched sha256', [ACCEPT_ANDROID[0], ACCEPT_ANDROID[1], { ...ACCEPT_ANDROID[2], sha256: '0'.repeat(64) }]],
    ['a stale version (the superseded Personal Terms)', [{ key: 'sign.personal_terms_of_service', version: '1.0', sha256: doc('sign.personal_terms_of_service', '1.0').sha256 }, ACCEPT_ANDROID[1], ACCEPT_ANDROID[2]]],
    ['an extra entry', [...ACCEPT_ANDROID, { key: 'sign.privacy_policy', version: '0.1.0', sha256: doc('sign.privacy_policy', '0.1.0').sha256 }]],
    ['an extra stale entry beside the current ones', [...ACCEPT_ANDROID, { key: 'sign.personal_terms_of_service', version: '1.0', sha256: doc('sign.personal_terms_of_service', '1.0').sha256 }]],
    ['a duplicate entry', [...ACCEPT_ANDROID, ACCEPT_ANDROID[0]]],
    ['a non-object entry', [...ACCEPT_ANDROID.slice(0, 2), 'aramo.acceptable_use_policy']],
  ])('%s → terms_not_accepted, nothing recorded', async (_l, accept) => {
    const h = harness();
    const r = await refusalOf(h.svc.complete({ signup_id: row().id, client: 'android', accept, ip: 'unknown', request_id: 'r', now: NOW }));
    expect(r).toMatchObject({ code: 'VALIDATION_ERROR', status: 400, reason: 'terms_not_accepted' });
    nothingRecorded(h);
  });

  it('a document version that takes effect DURING the signup is refused at complete (the app refetches)', async () => {
    const next: LegalDocumentVersion = { ...PRIVACY, version: '1.1', sha256: 'f'.repeat(64), effective_from: '2026-11-03T15:30:00Z', url: 'https://sign.aramo.ai/legal/privacy/1.1' };
    const h = harness({ registry: [...LEGAL_DOCUMENTS, next] });
    // The app fetched the terms at NOW (privacy 1.0) and completes after 1.1 took effect.
    const fetched = h.svc.currentTerms(NOW)!.map((t) => ({ key: t.key, version: t.version, sha256: t.sha256 }));
    expect(fetched).toEqual(ACCEPT_ANDROID);
    const later = new Date('2026-11-03T15:31:00Z');
    expect(await refusalOf(h.svc.complete({ signup_id: row().id, client: 'android', accept: fetched, ip: 'unknown', request_id: 'r', now: later }))).toMatchObject({
      reason: 'terms_not_accepted',
      details: { key: 'aramo.privacy_notice', version: '1.1' },
    });
    nothingRecorded(h);
  });

  it('a document hash that changes during the signup (same version) is refused', async () => {
    const changed = LEGAL_DOCUMENTS.map((d) => (d === AUP ? { ...d, sha256: 'e'.repeat(64) } : d));
    const h = harness({ registry: changed });
    expect((await refusalOf(h.svc.complete({ signup_id: row().id, client: 'android', accept: ACCEPT_ANDROID, ip: 'unknown', request_id: 'r', now: NOW }))).reason).toBe('terms_not_accepted');
    nothingRecorded(h);
  });

  it('client values other than web / android are refused at complete', async () => {
    const h = harness();
    expect(await refusalOf(h.svc.complete({ signup_id: row().id, client: 'ios', accept: ACCEPT_ANDROID, ip: 'unknown', request_id: 'r', now: NOW }))).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { field: 'client' },
    });
    nothingRecorded(h);
  });

  it('web {key, version} is unchanged: completes without sha256, records no origin and no client', async () => {
    const h = harness();
    const accept = ACCEPT_ANDROID.map(({ key, version }) => ({ key, version }));
    expect((await h.svc.complete({ signup_id: row().id, accept, ip: '203.0.113.9', user_agent: 'Mozilla/5.0', request_id: 'r', now: NOW })).status).toBe('PROVISIONED');
    for (const c of h.acceptances.record.mock.calls) expect((c as unknown as [{ origin?: unknown }])[0].origin).toBeUndefined();
    expect((h.requests.completeProvisioning.mock.calls[0] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('client');
  });

  it('web: an entry that does carry a sha256 must still match (stricter only)', async () => {
    const h = harness();
    const accept = [{ key: TOS.key, version: TOS.version, sha256: 'a'.repeat(64) }, ...ACCEPT_ANDROID.slice(1).map(({ key, version }) => ({ key, version }))];
    expect((await refusalOf(h.svc.complete({ signup_id: row().id, accept, ip: 'unknown', request_id: 'r', now: NOW }))).reason).toBe('terms_not_accepted');
    nothingRecorded(h);
  });
});

describe('the served legal texts are the registry-pinned bytes (repo files)', () => {
  const src = new LegalTextSource(REPO_ROOT);
  it.each([TOS, PRIVACY, AUP])('$key@$version', (d) => {
    expect(sha(Buffer.from(src.text(d)!, 'utf8'))).toBe(d.sha256);
  });
  it('refuses a registry path outside doc/legal', () => {
    expect(src.text({ ...PRIVACY, path: 'package.json' })).toBeNull();
    expect(src.text({ ...PRIVACY, path: '../etc/passwd' })).toBeNull();
  });
});
