import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalEmailForDuplicates, classifyEmailDomain, isPersonalOrDisposableDomain } from '../lib/util/email-domain.js';
import {
  PERSONAL_ALLOWED_COUNTRIES,
  normalizeE164,
  personalPilotCap,
  personalSignupMode,
  phoneRegion,
} from '../lib/util/personal-eligibility.js';
import {
  DEFAULT_PERSONAL_RISK_CONFIG,
  decisionForPoints,
  looksRandom,
  personalRiskConfig,
  ratePersonalSignup,
  type PersonalSignupSignalsInput,
} from '../lib/personal/personal-risk-rating.js';
import {
  PERSONAL_OTP_MAX_ATTEMPTS,
  PERSONAL_OTP_TTL_MS,
  checkPersonalOtp,
  generatePersonalOtp,
  hashPersonalOtp,
  mayResendPersonalOtp,
} from '../lib/personal/personal-otp.js';
import { evaluatePersonalSend, restrictionInForce, type TenantRiskStateView } from '../lib/personal/personal-risk.service.js';
import { generatePersonalInviteCode, hashPersonalInviteCode, initialRiskState } from '../lib/personal/personal-signup.repository.js';
import { DisabledSmsAdapter, LogSmsAdapter, smsVerificationAdapterFromEnv } from '../lib/personal/sms-verification.port.js';
import {
  DisabledRobotCheck,
  TestModeRobotCheck,
  TurnstileRobotCheckAdapter,
  robotCheckAdapterFromEnv,
} from '../lib/personal/robot-check.port.js';
import { MaxmindGeoIpAdapter, safeGeoLookup, type GeoIpPort } from '../lib/personal/geo-ip.port.js';
import { PersonalRiskService } from '../lib/personal/personal-risk.service.js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) — unit coverage of the
// identity-side Personal pieces: §2 classification (business behaviour unchanged),
// §6.6 phone region / countries / modes, §6.2 risk signals + thresholds, §3.2 /
// §6.3 one-time codes, the §6.3 / §6.6 send gate and the adapters.

describe('§2 classifyEmailDomain — one classification, reused', () => {
  it.each([
    ['gmail.com', 'personal'],
    ['yahoo.com', 'personal'],
    ['outlook.com', 'personal'],
    ['mailinator.com', 'disposable'],
    ['acme-corp.example', 'business'],
    ['astreconsulting.com', 'business'],
    ['', 'invalid'],
    ['localhost', 'invalid'],
  ])('%s → %s', (d, want) => {
    expect(classifyEmailDomain(d)).toBe(want);
  });

  it('isPersonalOrDisposableDomain keeps its exact behaviour (personal ∪ disposable)', () => {
    for (const d of ['gmail.com', 'GMAIL.COM', 'mailinator.com', 'yahoo.co.in']) expect(isPersonalOrDisposableDomain(d)).toBe(true);
    for (const d of ['acme-corp.example', 'astreconsulting.com', '', ' gmail.com', 'localhost']) expect(isPersonalOrDisposableDomain(d)).toBe(false);
  });

  it('Gmail canonicalization removes dots and +tag (gmail / googlemail only)', () => {
    expect(canonicalEmailForDuplicates('Jane.Doe+sign@Gmail.com')).toBe('janedoe@gmail.com');
    expect(canonicalEmailForDuplicates('j.a.n.e.doe@googlemail.com')).toBe('janedoe@gmail.com');
    expect(canonicalEmailForDuplicates('jane.doe+x@yahoo.com')).toBe('jane.doe+x@yahoo.com');
  });
});

describe('§6.6 eligibility', () => {
  it('phone region: US vs CA vs Caribbean (+1) and IN', () => {
    expect(phoneRegion('+12025550123')).toBe('US');
    expect(phoneRegion('+14165550123')).toBe('CA');
    expect(phoneRegion('+18765550123')).toBe('JM');
    expect(phoneRegion('+919876543210')).toBe('IN');
    expect(phoneRegion('2025550123')).toBeNull();
    expect(phoneRegion('+1202')).toBeNull();
  });

  it('normalizes a formatted number to E.164', () => {
    expect(normalizeE164('+1 (202) 555-0123')).toBe('+12025550123');
    expect(normalizeE164('not a phone')).toBeNull();
  });

  it('allowed countries default US,IN and parse the env', () => {
    expect(PERSONAL_ALLOWED_COUNTRIES({})).toEqual(['US', 'IN']);
    expect(PERSONAL_ALLOWED_COUNTRIES({ SIGN_PERSONAL_ALLOWED_COUNTRIES: ' us , in ,GB' })).toEqual(['US', 'IN', 'GB']);
    expect(PERSONAL_ALLOWED_COUNTRIES({ SIGN_PERSONAL_ALLOWED_COUNTRIES: 'xyz' })).toEqual(['US', 'IN']);
  });

  it('mode gate: off by default; only invite / open switch it on; pilot cap default 10', () => {
    expect(personalSignupMode({})).toBe('off');
    expect(personalSignupMode({ SIGN_PERSONAL_SIGNUP_MODE: 'INVITE' })).toBe('invite');
    expect(personalSignupMode({ SIGN_PERSONAL_SIGNUP_MODE: 'open' })).toBe('open');
    expect(personalSignupMode({ SIGN_PERSONAL_SIGNUP_MODE: 'yes' })).toBe('off');
    expect(personalPilotCap({})).toBe(10);
    expect(personalPilotCap({ SIGN_PERSONAL_PILOT_CAP: '3' })).toBe(3);
    expect(personalPilotCap({ SIGN_PERSONAL_PILOT_CAP: '-1' })).toBe(10);
  });
});

describe('§6.2 risk rating', () => {
  const clean: PersonalSignupSignalsInput = {
    robot: 'pass',
    network: 'residential',
    ip_signups_24h: 1,
    phone_region: 'US',
    ip_country: 'US',
    gmail_alias_of_existing: false,
    elapsed_ms: 20_000,
    honeypot_filled: false,
    name: 'Jane Doe',
    email_local_part: 'jane.doe',
    phone_reused: false,
  };

  it('a clean signup is allow with no signals', () => {
    expect(ratePersonalSignup(clean)).toEqual({ points: 0, decision: 'allow', signals: [] });
  });

  it.each([
    ['robot low', { robot: 'low' as const }, 'robot_check_low', 40],
    ['hosting network', { network: 'hosting' as const }, 'network_hosting_vpn_tor', 25],
    ['tor network', { network: 'tor' as const }, 'network_hosting_vpn_tor', 25],
    ['3 signups from the IP', { ip_signups_24h: 3 }, 'ip_signups_24h', 20],
    ['phone/IP country mismatch', { ip_country: 'IN' }, 'phone_ip_country_mismatch', 15],
    ['gmail alias', { gmail_alias_of_existing: true }, 'gmail_alias_of_existing', 30],
    ['form under 4 s', { elapsed_ms: 3999 }, 'fast_form', 40],
    ['no elapsed time', { elapsed_ms: null }, 'fast_form', 40],
    ['random-looking local part', { email_local_part: 'xkqzvbtrw991' }, 'random_looking', 10],
    ['phone reused', { phone_reused: true }, 'phone_reused', 30],
    // Architect ruling 2026-10-21 — the network country is a risk signal (with the allowed set given).
    ['network country outside US/IN', { ip_country: 'GB', phone_region: 'GB', allowed_countries: ['US', 'IN'] }, 'ip_country_outside', 60],
    ['network country unknown', { ip_country: null, allowed_countries: ['US', 'IN'] }, 'ip_country_unknown', 30],
  ])('%s adds its points', (_label, patch, key, points) => {
    const r = ratePersonalSignup({ ...clean, ...patch });
    expect(r.signals).toEqual([expect.objectContaining({ key, points })]);
    expect(r.points).toBe(points);
  });

  it.each([
    ['honeypot', { honeypot_filled: true }, 'honeypot_filled'],
    ['robot failed', { robot: 'fail' as const }, 'robot_check_failed'],
    ['6 signups from the IP', { ip_signups_24h: 6 }, 'ip_signups_24h'],
  ])('%s refuses outright', (_l, patch, key) => {
    const r = ratePersonalSignup({ ...clean, ...patch });
    expect(r.decision).toBe('refuse');
    expect(r.signals).toEqual([expect.objectContaining({ key, refuse: true })]);
  });

  it('thresholds: <30 allow, 30–59 step_up, 60–89 review, ≥90 refuse', () => {
    expect([0, 29, 30, 59, 60, 89, 90, 200].map((p) => decisionForPoints(p))).toEqual([
      'allow', 'allow', 'step_up', 'step_up', 'review', 'review', 'refuse', 'refuse',
    ]);
    expect(ratePersonalSignup({ ...clean, gmail_alias_of_existing: true }).decision).toBe('step_up');
    expect(ratePersonalSignup({ ...clean, elapsed_ms: 100, network: 'vpn' }).decision).toBe('review');
    expect(ratePersonalSignup({ ...clean, elapsed_ms: 100, robot: 'low', phone_reused: true }).decision).toBe('refuse');
  });

  it('network country alone: outside → review, unknown → step_up, inside → nothing; never a refusal by itself', () => {
    const allowed = ['US', 'IN'];
    const outside = ratePersonalSignup({ ...clean, ip_country: 'DE', allowed_countries: allowed });
    expect(outside.decision).toBe('review');
    // The phone/IP mismatch still fires alongside (US phone, DE network): 60 + 15.
    expect(outside.signals.map((x) => x.key)).toEqual(['ip_country_outside', 'phone_ip_country_mismatch']);
    expect(outside.signals[0]).toMatchObject({ detail: 'DE' });
    expect(ratePersonalSignup({ ...clean, ip_country: null, allowed_countries: allowed })).toMatchObject({ points: 30, decision: 'step_up' });
    expect(ratePersonalSignup({ ...clean, ip_country: 'IN', phone_region: 'IN', allowed_countries: allowed })).toEqual({ points: 0, decision: 'allow', signals: [] });
    expect(outside.signals.some((x) => x.refuse === true)).toBe(false);
    const cfg = personalRiskConfig({ SIGN_PERSONAL_RISK_CONFIG: JSON.stringify({ points: { ip_country_outside: 10, ip_country_unknown: 0 } }) });
    expect(cfg.points).toMatchObject({ ip_country_outside: 10, ip_country_unknown: 0 });
    expect(ratePersonalSignup({ ...clean, ip_country: null, allowed_countries: allowed }, cfg)).toMatchObject({ points: 0, decision: 'allow' });
  });

  it('points and thresholds are configuration (bad overrides fall back)', () => {
    const cfg = personalRiskConfig({ SIGN_PERSONAL_RISK_CONFIG: JSON.stringify({ points: { fast_form: 5 }, thresholds: { step_up: 10, review: 20, refuse: 30 } }) });
    expect(cfg.points.fast_form).toBe(5);
    expect(cfg.points.robot_low).toBe(40);
    expect(ratePersonalSignup({ ...clean, elapsed_ms: 10, ip_country: 'IN' }, cfg)).toMatchObject({ points: 20, decision: 'review' });
    expect(personalRiskConfig({ SIGN_PERSONAL_RISK_CONFIG: '{bad' })).toBe(DEFAULT_PERSONAL_RISK_CONFIG);
    expect(personalRiskConfig({ SIGN_PERSONAL_RISK_CONFIG: JSON.stringify({ thresholds: { step_up: 90, review: 10, refuse: 5 } }) }).thresholds).toEqual(DEFAULT_PERSONAL_RISK_CONFIG.thresholds);
  });

  it('random-looking heuristic leaves ordinary names alone', () => {
    for (const v of ['Jane Doe', 'Priya Raghunathan', 'Knightsbridge', 'john.smith', 'Nguyen']) expect(looksRandom(v)).toBe(false);
    for (const v of ['qwrtzpsdf', 'xkqzvbtrw991', 'ab12cd3456ef']) expect(looksRandom(v)).toBe(true);
  });
});

describe('§3.2 / §6.3 one-time codes', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const id = '01900000-0000-7000-8000-0000000000aa';

  it('6 digits; only a channel-bound hash is stored', () => {
    const code = generatePersonalOtp();
    expect(code).toMatch(/^\d{6}$/);
    expect(hashPersonalOtp(id, 'email', code)).not.toBe(hashPersonalOtp(id, 'phone', code));
    expect(hashPersonalOtp(id, 'email', code)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lifecycle: ok, mismatch, expired after 10 min, exhausted after 5 attempts, none', () => {
    const hash = hashPersonalOtp(id, 'email', '123456');
    const state = { hash, expires_at: new Date(now.getTime() + PERSONAL_OTP_TTL_MS), attempts: 0 };
    expect(checkPersonalOtp(state, id, 'email', '123456', now)).toBe('ok');
    expect(checkPersonalOtp(state, id, 'phone', '123456', now)).toBe('mismatch');
    expect(checkPersonalOtp(state, id, 'email', '654321', now)).toBe('mismatch');
    expect(checkPersonalOtp(state, id, 'email', 123456, now)).toBe('mismatch');
    expect(checkPersonalOtp(state, id, 'email', '123456', new Date(now.getTime() + PERSONAL_OTP_TTL_MS))).toBe('expired');
    expect(checkPersonalOtp({ ...state, attempts: PERSONAL_OTP_MAX_ATTEMPTS }, id, 'email', '123456', now)).toBe('exhausted');
    expect(checkPersonalOtp({ hash: null, expires_at: null, attempts: 0 }, id, 'email', '123456', now)).toBe('none');
  });

  it('resend after 60 s, at most 5 a day', () => {
    expect(mayResendPersonalOtp({ last_sent_at: null, sends_last_24h: 0, now })).toBe(true);
    expect(mayResendPersonalOtp({ last_sent_at: new Date(now.getTime() - 59_000), sends_last_24h: 1, now })).toBe(false);
    expect(mayResendPersonalOtp({ last_sent_at: new Date(now.getTime() - 60_000), sends_last_24h: 4, now })).toBe(true);
    expect(mayResendPersonalOtp({ last_sent_at: new Date(now.getTime() - 3_600_000), sends_last_24h: 5, now })).toBe(false);
  });

  it('invite codes: 12 characters shown once; the hash ignores case and dashes', () => {
    const code = generatePersonalInviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(hashPersonalInviteCode(code)).toBe(hashPersonalInviteCode(code.toLowerCase().replace(/-/g, '')));
  });
});

describe('§6.3 / §6.6 send gate', () => {
  const now = new Date('2026-10-21T12:00:00Z');
  const base: TenantRiskStateView = {
    tenant_id: 't',
    state: 'clear',
    step_up_required: false,
    review_pending: false,
    phone_e164: '+12025550123',
    phone_verified_at: null,
    restricted_until: null,
    reason: null,
    decided_by: null,
    step_up_cleared_by: null,
    created_at: now,
    updated_at: now,
  };
  const allowed = ['US', 'IN'];
  const at = (v: TenantRiskStateView | null, ip_country: string | null = 'US') => evaluatePersonalSend(v, { ip_country, now, allowed_countries: allowed });
  const old: TenantRiskStateView = { ...base, created_at: new Date(now.getTime() - 8 * 86_400_000) };

  it('clear in US / IN sends; no risk row fails closed', () => {
    expect(at(base)).toEqual({ ok: true, location: 'inside' });
    expect(at(base, 'in')).toEqual({ ok: true, location: 'inside' });
    expect(at(null)).toEqual({ ok: false, reason: 'personal_review_pending' });
  });

  it('review, restricted (indefinite or future) and closed block; an expired pause does not', () => {
    expect(at({ ...base, state: 'review' })).toEqual({ ok: false, reason: 'personal_review_pending' });
    expect(at({ ...base, state: 'restricted' })).toEqual({ ok: false, reason: 'personal_restricted' });
    expect(at({ ...base, state: 'restricted', restricted_until: new Date(now.getTime() + 1000) })).toEqual({ ok: false, reason: 'personal_restricted' });
    expect(at({ ...base, state: 'restricted', restricted_until: new Date(now.getTime() - 1000) })).toEqual({ ok: true, location: 'inside' });
    expect(at({ ...base, state: 'closed' })).toEqual({ ok: false, reason: 'personal_restricted' });
    // Correction D — a review owed under an expired automatic pause still holds sending.
    expect(at({ ...base, state: 'restricted', review_pending: true, restricted_until: new Date(now.getTime() - 1000) })).toEqual({ ok: false, reason: 'personal_review_pending' });
    expect(restrictionInForce({ state: 'clear', restricted_until: null }, now)).toBe(false);
  });

  it('outstanding step-up needs phone assurance', () => {
    expect(at({ ...base, step_up_required: true })).toEqual({ ok: false, reason: 'phone_verification_required', location: 'inside' });
    expect(at({ ...base, step_up_required: true, phone_verified_at: now })).toEqual({ ok: true, location: 'inside' });
  });

  it('outside US / IN or UNKNOWN: allowed for an established account (no phone rule); never personal_location_not_supported', () => {
    expect(at(old, 'GB')).toEqual({ ok: true, location: 'outside' });
    expect(at(old, null)).toEqual({ ok: true, location: 'unknown' });
    for (const c of ['GB', null, 'BR']) expect(JSON.stringify(at(old, c))).not.toContain('personal_location_not_supported');
  });

  it('outside / UNKNOWN on a young account (< 7 days) or with a step-up outstanding → review (flagged)', () => {
    expect(at(base, 'GB')).toEqual({ ok: false, reason: 'personal_review_pending', location: 'outside', flag_review: 'send_location_outside' });
    expect(at(base, null)).toEqual({ ok: false, reason: 'personal_review_pending', location: 'unknown', flag_review: 'send_location_unknown' });
    expect(at({ ...base, created_at: new Date(now.getTime() - 7 * 86_400_000) }, 'GB')).toEqual({ ok: true, location: 'outside' });
    expect(at({ ...old, step_up_required: true }, 'GB')).toMatchObject({ ok: false, reason: 'personal_review_pending', flag_review: 'send_location_outside' });
    // A satisfied step-up is not an open signal.
    expect(at({ ...old, step_up_required: true, phone_verified_at: now }, 'GB')).toEqual({ ok: true, location: 'outside' });
    // Review / restriction keep their own refusals (no extra flag).
    expect(at({ ...old, state: 'review' }, 'GB')).toEqual({ ok: false, reason: 'personal_review_pending' });
    expect(at({ ...old, state: 'restricted' }, null)).toEqual({ ok: false, reason: 'personal_restricted' });
  });

  it('initial risk state from the signup decision (SMS available vs not)', () => {
    expect(initialRiskState('allow', false)).toEqual({ state: 'clear', step_up_required: false, reason: null });
    expect(initialRiskState('review', true)).toMatchObject({ state: 'review', step_up_required: false });
    expect(initialRiskState('step_up', true)).toMatchObject({ state: 'clear', step_up_required: true });
    expect(initialRiskState('step_up', false)).toEqual({ state: 'review', step_up_required: true, reason: 'signup_step_up_unverified' });
    expect(initialRiskState('step_up', false, false)).toEqual({ state: 'review', step_up_required: true, reason: 'step_up_phone_unavailable' });
    expect(initialRiskState('allow', false, false)).toEqual({ state: 'clear', step_up_required: false, reason: null });
  });

  it('review lifts the phone step only while SMS is unavailable', () => {
    const noSms = new PersonalRiskService({} as never, new DisabledSmsAdapter());
    const sms = new PersonalRiskService({} as never, new LogSmsAdapter());
    expect(noSms.reviewClearsStepUp({ step_up_required: true, phone_verified_at: null })).toBe(true);
    expect(noSms.reviewClearsStepUp({ step_up_required: true, phone_verified_at: now })).toBe(false);
    expect(noSms.reviewClearsStepUp({ step_up_required: false, phone_verified_at: null })).toBe(false);
    expect(sms.reviewClearsStepUp({ step_up_required: true, phone_verified_at: null })).toBe(false);
    expect(noSms.phoneVerificationAvailable()).toBe(false);
    expect(sms.phoneVerificationAvailable()).toBe(true);
  });
});

describe('adapters', () => {
  it('SMS: disabled by default (configured=false), log records', async () => {
    const off = smsVerificationAdapterFromEnv({});
    expect(off).toBeInstanceOf(DisabledSmsAdapter);
    expect(off.configured).toBe(false);
    expect(await off.send('+12025550123', 'x')).toEqual({ ok: false, ref: null });
    const log = smsVerificationAdapterFromEnv({ SIGN_SMS_PROVIDER: 'log' }) as LogSmsAdapter;
    expect(log).toBeInstanceOf(LogSmsAdapter);
    expect((await log.send('+12025550123', 'code 1')).ok).toBe(true);
    expect(log.sent).toHaveLength(1);
  });

  it('robot check: disabled → unavailable; test mode → pass; secret → Turnstile', async () => {
    expect(robotCheckAdapterFromEnv({})).toBeInstanceOf(DisabledRobotCheck);
    expect(await new DisabledRobotCheck().verify()).toEqual({ verdict: 'unavailable' });
    expect(robotCheckAdapterFromEnv({ SIGN_TURNSTILE_MODE: 'test', SIGN_TURNSTILE_SECRET: 's' })).toBeInstanceOf(TestModeRobotCheck);
    expect(robotCheckAdapterFromEnv({ SIGN_TURNSTILE_SECRET: 's' })).toBeInstanceOf(TurnstileRobotCheckAdapter);
  });

  it('Turnstile verdicts: success → pass, bad token → fail, secret problem / outage → unavailable', async () => {
    const reply = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });
    const sent: string[] = [];
    const pass = new TurnstileRobotCheckAdapter('sec', async (_u, init) => (sent.push(init.body), { ok: true, json: async () => ({ success: true }) }));
    expect(await pass.verify('tok', '203.0.113.9')).toEqual({ verdict: 'pass' });
    expect(sent[0]).toContain('remoteip=203.0.113.9');
    expect(await new TurnstileRobotCheckAdapter('s', reply({ success: false, 'error-codes': ['invalid-input-response'] })).verify('t', '1.1.1.1')).toEqual({ verdict: 'fail' });
    expect(await new TurnstileRobotCheckAdapter('s', reply({ success: false, 'error-codes': ['invalid-input-secret'] })).verify('t', '1.1.1.1')).toEqual({ verdict: 'unavailable' });
    expect(await new TurnstileRobotCheckAdapter('s', reply({}, false)).verify('t', '1.1.1.1')).toEqual({ verdict: 'unavailable' });
    expect(await new TurnstileRobotCheckAdapter('s', async () => { throw new Error('down'); }).verify('t', '1.1.1.1')).toEqual({ verdict: 'unavailable' });
    expect(await new TurnstileRobotCheckAdapter('s', reply({ success: true })).verify(null, '1.1.1.1')).toEqual({ verdict: 'fail' });
  });

  it('GeoIP with no database is UNKNOWN (country null, network unknown, no db_version), never throws', async () => {
    const geo = new MaxmindGeoIpAdapter(undefined, '/nonexistent/asn.mmdb');
    expect(await geo.countryOf('8.8.8.8')).toBeNull();
    expect(await geo.networkKind('8.8.8.8')).toBe('unknown');
    expect(await geo.countryOf('not-an-ip')).toBeNull();
    const at = new Date('2026-10-21T12:00:00Z');
    expect(await new MaxmindGeoIpAdapter('/nonexistent/country.mmdb').lookup('8.8.8.8', at)).toEqual({
      country: null,
      network_kind: 'unknown',
      looked_up_at: '2026-10-21T12:00:00.000Z',
      db_version: null,
    });
  });

  it('GeoIP reads the country + db_version (type + build time) and picks up a replaced file without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'geoip-'));
    const path = join(dir, 'GeoLite2-Country.mmdb');
    try {
      writeFileSync(path, tinyCountryMmdb(['US', 'GB'], 1_760_000_000));
      const geo = new MaxmindGeoIpAdapter(path, undefined, 0);
      const first = await geo.lookup('8.8.8.8');
      expect(first).toMatchObject({ country: 'US', db_version: `GeoLite2-Country ${new Date(1_760_000_000_000).toISOString()}` });
      expect(await geo.countryOf('200.1.2.3')).toBe('GB');
      // The updater writes a new file and renames it over the old one.
      writeFileSync(`${path}.tmp`, tinyCountryMmdb(['IN', 'DE'], 1_761_000_000));
      renameSync(`${path}.tmp`, path);
      expect(await geo.lookup('8.8.8.8')).toMatchObject({ country: 'IN', db_version: `GeoLite2-Country ${new Date(1_761_000_000_000).toISOString()}` });
      // A corrupt replacement keeps the last good database (never throws, never guesses).
      writeFileSync(`${path}.tmp`, Buffer.from('not a database'));
      renameSync(`${path}.tmp`, path);
      expect(await geo.countryOf('8.8.8.8')).toBe('IN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('safeGeoLookup: a throwing port or no IP is UNKNOWN', async () => {
    const boom: GeoIpPort = {
      countryOf: async () => 'US',
      networkKind: async () => 'residential',
      lookup: async () => {
        throw new Error('db exploded');
      },
    };
    const at = new Date('2026-10-21T12:00:00Z');
    expect(await safeGeoLookup(boom, '8.8.8.8', at)).toEqual({ country: null, network_kind: 'unknown', looked_up_at: at.toISOString(), db_version: null });
    expect(await safeGeoLookup(boom, null, at)).toMatchObject({ country: null });
  });
});

// A minimal MaxMind DB (IPv4, one node, 24-bit records): 0.0.0.0/1 → left country,
// 128.0.0.0/1 → right country. Enough to exercise the real reader + metadata.
function tinyCountryMmdb([left, right]: [string, string] | string[], buildEpoch: number): Buffer {
  const str = (v: string) => Buffer.concat([Buffer.from([0x40 | Buffer.byteLength(v)]), Buffer.from(v)]);
  const uint = (type: 5 | 6, n: number, bytes: number) => {
    const b = Buffer.alloc(bytes);
    b.writeUIntBE(n, 0, bytes);
    return Buffer.concat([Buffer.from([(type << 5) | bytes]), b]);
  };
  const uint64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return Buffer.concat([Buffer.from([8, 9 - 7]), b]); // extended type 9 (uint64)
  };
  const map = (entries: [string, Buffer][]) => Buffer.concat([Buffer.from([0xe0 | entries.length]), ...entries.flatMap(([k, v]) => [str(k), v])]);
  const country = (iso: string) => map([['country', map([['iso_code', str(iso)]])]]);
  const a = country(left!);
  const b = country(right!);
  const nodeCount = 1;
  const rec = (offset: number) => {
    const v = nodeCount + 16 + offset;
    return Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  };
  const tree = Buffer.concat([rec(0), rec(a.length)]);
  const meta = map([
    ['node_count', uint(6, nodeCount, 4)],
    ['record_size', uint(5, 24, 2)],
    ['ip_version', uint(5, 4, 2)],
    ['database_type', str('GeoLite2-Country')],
    ['binary_format_major_version', uint(5, 2, 2)],
    ['binary_format_minor_version', uint(5, 0, 2)],
    ['build_epoch', uint64(buildEpoch)],
  ]);
  return Buffer.concat([tree, Buffer.alloc(16), a, b, Buffer.from('ABCDEF4D61784D696E642E636F6D', 'hex'), meta]);
}
