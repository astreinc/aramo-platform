import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { IdentityCoreModule } from '../lib/identity-core.module.js';
import {
  GOOGLE_OAUTH_TOKEN_URL,
  GooglePlayIntegrityDecoder,
  NATIVE_INTEGRITY_CHECK,
  PLAY_INTEGRITY_DECODE_URL,
  PLAY_INTEGRITY_SCOPE,
  PlatformNativeIntegrityCheck,
  PlayIntegrityCheck,
  UnconfiguredNativeIntegrityCheck,
  certificateDigestHex,
  evaluatePlayIntegrityPayload,
  nativeIntegrityCheckFromEnv,
  nativeSignupCanonicalRequest,
  nativeSignupRequestHash,
  normalizeCertificateHex,
  parseServiceAccount,
  type PlayIntegrityDecodeResult,
  type PlayIntegrityDecoder,
} from '../lib/personal/native-integrity.port.js';

// Aramo-Sign-Mobile-Amendment-M-A11 (LOCKED) §2.1 / §5 — the native integrity check:
// positive and negative for every check, the Google transport, the env binding, and
// that the production module binds the Google decoder (no bypass).

// The production Play app-signing certificate (contract) and the upload key, which must NOT pass.
const APP_SIGNING = 'E2:A5:F8:77:E9:6A:F5:9F:CA:70:C8:68:2B:5D:F1:25:AC:33:D9:11:A3:BB:FD:C6:02:B6:CD:6F:64:E2:B6:58';
const APP_SIGNING_HEX = APP_SIGNING.replace(/:/g, '').toLowerCase();
const UPLOAD_KEY_HEX = '16323f' + 'ab'.repeat(29);
const b64url = (hex: string) => Buffer.from(hex, 'hex').toString('base64url');

const NOW = new Date('2026-11-03T15:00:00Z');
const BODY = {
  client: 'android',
  name: 'Pat Person',
  email: 'pat.person@gmail.com',
  phone: '+12025550101',
  residence: 'US',
  invite_code: null,
  hp: '',
  elapsed_ms: 20_000,
};
const HASH = nativeSignupRequestHash(BODY);

function payload(over: { request?: Record<string, unknown>; app?: Record<string, unknown>; device?: Record<string, unknown> | null } = {}) {
  return {
    requestDetails: { requestPackageName: 'ai.aramo.sign', timestampMillis: String(NOW.getTime() - 5_000), requestHash: HASH, ...over.request },
    appIntegrity: {
      appRecognitionVerdict: 'PLAY_RECOGNIZED',
      packageName: 'ai.aramo.sign',
      certificateSha256Digest: [b64url(APP_SIGNING_HEX)],
      versionCode: '1',
      ...over.app,
    },
    ...(over.device === null ? {} : { deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'], ...over.device } }),
  };
}

const WANT = { request_hash: HASH, package_name: 'ai.aramo.sign', certificate_sha256_hex: APP_SIGNING_HEX, max_age_ms: 300_000, now: NOW };

describe('§2.1 (1) canonical request and requestHash', () => {
  it('matches the Android app byte for byte (vectors pinned in mobile/sign integrity.test.ts)', () => {
    const v = (client: string, name: string, email: string, phone: string, residence: string, invite_code: string | null, elapsed_ms: number) =>
      nativeSignupRequestHash({ client, name, email, phone, residence, invite_code, hp: '', elapsed_ms });
    expect(v('android', 'Pat Lee', 'pat.lee@gmail.com', '+14155550100', 'US', null, 8423)).toBe(
      'fd66ae8ac42b6818c47718c68fc404bfb907a4ef5d0088161cc00a7223d5eba7',
    );
    expect(v('android', 'Zoë Ñúñez 李', 'zoe@gmail.com', '+919876543210', 'IN', 'PILOT-7', 12000)).toBe(
      '24f1edd3484417dd14b2ff29a707a9921e35813beeb6c065815a14f31fd5a9a0',
    );
  });

  it('is the JSON array in the fixed order, invite_code null when absent, hashed as lowercase hex SHA-256', () => {
    const canonical = nativeSignupCanonicalRequest({ ...BODY, invite_code: undefined });
    expect(canonical).toBe('["android","Pat Person","pat.person@gmail.com","+12025550101","US",null,"",20000]');
    expect(nativeSignupRequestHash({ ...BODY, invite_code: undefined })).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
    expect(HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('uses the values exactly as sent (no trim or lower-casing)', () => {
    expect(nativeSignupRequestHash({ ...BODY, email: 'Pat.Person@gmail.com ' })).not.toBe(HASH);
    expect(nativeSignupRequestHash({ ...BODY, name: ' Pat Person' })).not.toBe(HASH);
  });
});

describe('§2.1 (2) every check — positive and negative', () => {
  it('passes when every check holds', () => {
    expect(evaluatePlayIntegrityPayload(payload(), WANT)).toEqual({ verdict: 'pass', reason: 'ok' });
  });

  it('requestHash mismatch (a different body) fails', () => {
    expect(evaluatePlayIntegrityPayload(payload(), { ...WANT, request_hash: nativeSignupRequestHash({ ...BODY, phone: '+12025550102' }) })).toEqual({
      verdict: 'fail',
      reason: 'request_hash_mismatch',
    });
  });

  it('a token from another request (its own hash) fails', () => {
    const other = nativeSignupRequestHash({ ...BODY, email: 'someone.else@gmail.com' });
    expect(evaluatePlayIntegrityPayload(payload({ request: { requestHash: other } }), WANT).reason).toBe('request_hash_mismatch');
    expect(evaluatePlayIntegrityPayload(payload({ request: { requestHash: undefined } }), WANT).reason).toBe('request_hash_mismatch');
  });

  it('wrong package (request or app) fails', () => {
    expect(evaluatePlayIntegrityPayload(payload({ request: { requestPackageName: 'com.example.fake' } }), WANT).reason).toBe('package_mismatch');
    expect(evaluatePlayIntegrityPayload(payload({ app: { packageName: 'com.example.fake' } }), WANT).reason).toBe('package_mismatch');
  });

  it.each(['UNRECOGNIZED_VERSION', 'UNEVALUATED', undefined])('appRecognitionVerdict %s fails', (v) => {
    expect(evaluatePlayIntegrityPayload(payload({ app: { appRecognitionVerdict: v } }), WANT)).toEqual({ verdict: 'fail', reason: 'app_not_recognized' });
  });

  it('the upload-key certificate or an unknown certificate fails; the app-signing certificate among several passes', () => {
    expect(evaluatePlayIntegrityPayload(payload({ app: { certificateSha256Digest: [b64url(UPLOAD_KEY_HEX)] } }), WANT).reason).toBe('certificate_mismatch');
    expect(evaluatePlayIntegrityPayload(payload({ app: { certificateSha256Digest: [b64url('00'.repeat(32))] } }), WANT).reason).toBe('certificate_mismatch');
    expect(evaluatePlayIntegrityPayload(payload({ app: { certificateSha256Digest: [] } }), WANT).reason).toBe('certificate_mismatch');
    expect(evaluatePlayIntegrityPayload(payload({ app: { certificateSha256Digest: [APP_SIGNING_HEX] } }), WANT).reason).toBe('certificate_mismatch');
    expect(evaluatePlayIntegrityPayload(payload({ app: { certificateSha256Digest: [b64url(UPLOAD_KEY_HEX), b64url(APP_SIGNING_HEX)] } }), WANT).verdict).toBe('pass');
  });

  it('missing device verdict fails (absent, empty, or basic-only)', () => {
    expect(evaluatePlayIntegrityPayload(payload({ device: null }), WANT).reason).toBe('device_integrity_missing');
    expect(evaluatePlayIntegrityPayload(payload({ device: { deviceRecognitionVerdict: [] } }), WANT).reason).toBe('device_integrity_missing');
    expect(evaluatePlayIntegrityPayload(payload({ device: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } }), WANT).reason).toBe('device_integrity_missing');
    expect(evaluatePlayIntegrityPayload(payload({ device: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY', 'MEETS_DEVICE_INTEGRITY', 'MEETS_STRONG_INTEGRITY'] } }), WANT).verdict).toBe('pass');
  });

  it('freshness: inside the window passes; stale and future fail; the boundaries are inclusive', () => {
    const at = (ms: number) => payload({ request: { timestampMillis: String(ms) } });
    expect(evaluatePlayIntegrityPayload(at(NOW.getTime() - 300_000), WANT).verdict).toBe('pass');
    expect(evaluatePlayIntegrityPayload(at(NOW.getTime() - 300_001), WANT)).toEqual({ verdict: 'fail', reason: 'timestamp_stale' });
    expect(evaluatePlayIntegrityPayload(at(NOW.getTime() + 60_000), WANT).verdict).toBe('pass');
    expect(evaluatePlayIntegrityPayload(at(NOW.getTime() + 60_001), WANT)).toEqual({ verdict: 'fail', reason: 'timestamp_future' });
    expect(evaluatePlayIntegrityPayload(payload({ request: { timestampMillis: NOW.getTime() } }), WANT).verdict).toBe('pass');
    expect(evaluatePlayIntegrityPayload(payload({ request: { timestampMillis: 'soon' } }), WANT).reason).toBe('timestamp_invalid');
    expect(evaluatePlayIntegrityPayload(payload({ request: { timestampMillis: undefined } }), WANT).reason).toBe('timestamp_invalid');
  });

  it('a malformed payload fails', () => {
    expect(evaluatePlayIntegrityPayload(null, WANT).reason).toBe('payload_malformed');
    expect(evaluatePlayIntegrityPayload({ requestDetails: {} }, WANT).reason).toBe('payload_malformed');
  });

  it('certificate digests: Google base64url ↔ configured hex with colons', () => {
    expect(certificateDigestHex(b64url(APP_SIGNING_HEX))).toBe(APP_SIGNING_HEX);
    expect(certificateDigestHex('not base64!')).toBeNull();
    expect(certificateDigestHex(b64url('ab'))).toBeNull();
    expect(normalizeCertificateHex(APP_SIGNING)).toBe(APP_SIGNING_HEX);
    expect(normalizeCertificateHex('E2:A5')).toBeNull();
  });
});

class FakeDecoder implements PlayIntegrityDecoder {
  calls: { pkg: string; token: string }[] = [];
  constructor(public result: PlayIntegrityDecodeResult) {}
  async decode(pkg: string, token: string): Promise<PlayIntegrityDecodeResult> {
    this.calls.push({ pkg, token });
    return this.result;
  }
}

describe('PlayIntegrityCheck — verdicts', () => {
  const cfg = { package_name: 'ai.aramo.sign', certificate_sha256_hex: APP_SIGNING_HEX, max_age_seconds: 300 };

  it('pass: the token is decoded for the configured package and every check holds', async () => {
    const d = new FakeDecoder({ kind: 'payload', payload: payload() });
    expect(await new PlayIntegrityCheck(cfg, d).verify({ token: 'tok', request_hash: HASH, now: NOW })).toEqual({ verdict: 'pass', reason: 'ok' });
    expect(d.calls).toEqual([{ pkg: 'ai.aramo.sign', token: 'tok' }]);
  });

  it('fail: a check fails (hash recomputed from a different body)', async () => {
    const d = new FakeDecoder({ kind: 'payload', payload: payload() });
    const other = nativeSignupRequestHash({ ...BODY, elapsed_ms: 20_001 });
    expect(await new PlayIntegrityCheck(cfg, d).verify({ token: 'tok', request_hash: other, now: NOW })).toEqual({ verdict: 'fail', reason: 'request_hash_mismatch' });
  });

  it('fail: no token / empty token / Google rejects the token — nothing is decoded without a token', async () => {
    const d = new FakeDecoder({ kind: 'payload', payload: payload() });
    expect(await new PlayIntegrityCheck(cfg, d).verify({ token: null, request_hash: HASH, now: NOW })).toEqual({ verdict: 'fail', reason: 'token_missing' });
    expect(await new PlayIntegrityCheck(cfg, d).verify({ token: '  ', request_hash: HASH, now: NOW })).toEqual({ verdict: 'fail', reason: 'token_missing' });
    expect(d.calls).toHaveLength(0);
    expect(await new PlayIntegrityCheck(cfg, new FakeDecoder({ kind: 'rejected' })).verify({ token: 'tok', request_hash: HASH, now: NOW })).toEqual({
      verdict: 'fail',
      reason: 'token_rejected',
    });
  });

  it('unavailable: the decode API is unavailable (fail closed)', async () => {
    expect(await new PlayIntegrityCheck(cfg, new FakeDecoder({ kind: 'unavailable' })).verify({ token: 'tok', request_hash: HASH, now: NOW })).toEqual({
      verdict: 'unavailable',
      reason: 'decode_unavailable',
    });
  });

  it('never logs the token or the payload (reason codes only)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const secret = 'SECRET-TOKEN-VALUE';
    await new PlayIntegrityCheck(cfg, new FakeDecoder({ kind: 'payload', payload: payload({ app: { appRecognitionVerdict: 'UNEVALUATED' } }) })).verify({
      token: secret,
      request_hash: HASH,
      now: NOW,
    });
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('app_not_recognized');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(HASH);
    warn.mockRestore();
  });
});

describe('GooglePlayIntegrityDecoder — service-account JWT → OAuth token → decodeIntegrityToken', () => {
  let pem: string;
  let publicKey: CryptoKey;
  beforeAll(async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    pem = await exportPKCS8(kp.privateKey);
    publicKey = kp.publicKey as CryptoKey;
  });
  const account = () => ({ client_email: 'decoder@aramo-sign.iam.gserviceaccount.com', private_key: pem, private_key_id: 'kid-1' });

  type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };
  function fakeFetch(decode: { status: number; body?: unknown } | Error, token: { status: number; body?: unknown } = { status: 200, body: { access_token: 'at-1', expires_in: 3600 } }) {
    const calls: Call[] = [];
    const impl = async (url: string, init: Call['init']) => {
      calls.push({ url, init });
      const r = url === GOOGLE_OAUTH_TOKEN_URL ? token : decode;
      if (r instanceof Error) throw r;
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    };
    return { calls, impl };
  }

  it('signs an RS256 assertion (scope playintegrity), exchanges it, decodes, and caches the access token until expiry', async () => {
    let now = NOW.getTime();
    const f = fakeFetch({ status: 200, body: { tokenPayloadExternal: { hello: 'payload' } } });
    const d = new GooglePlayIntegrityDecoder(account(), f.impl, () => now);
    expect(await d.decode('ai.aramo.sign', 'tok')).toEqual({ kind: 'payload', payload: { hello: 'payload' } });
    const [tokenCall, decodeCall] = f.calls;
    expect(tokenCall!.url).toBe(GOOGLE_OAUTH_TOKEN_URL);
    const form = new URLSearchParams(tokenCall!.init.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { payload: claims, protectedHeader } = await jwtVerify(form.get('assertion')!, publicKey, { audience: GOOGLE_OAUTH_TOKEN_URL, currentDate: NOW });
    expect(protectedHeader).toMatchObject({ alg: 'RS256', kid: 'kid-1' });
    expect(claims).toMatchObject({ iss: 'decoder@aramo-sign.iam.gserviceaccount.com', scope: PLAY_INTEGRITY_SCOPE });
    expect(decodeCall!.url).toBe(PLAY_INTEGRITY_DECODE_URL('ai.aramo.sign'));
    expect(decodeCall!.url).toBe('https://playintegrity.googleapis.com/v1/ai.aramo.sign:decodeIntegrityToken');
    expect(decodeCall!.init.headers['authorization']).toBe('Bearer at-1');
    expect(JSON.parse(decodeCall!.init.body)).toEqual({ integrity_token: 'tok' });

    await d.decode('ai.aramo.sign', 'tok2');
    expect(f.calls.filter((c) => c.url === GOOGLE_OAUTH_TOKEN_URL)).toHaveLength(1);
    now += 3600 * 1000;
    await d.decode('ai.aramo.sign', 'tok3');
    expect(f.calls.filter((c) => c.url === GOOGLE_OAUTH_TOKEN_URL)).toHaveLength(2);
  });

  it('Google refusing the token (400) is a rejection; 401/403/429/5xx and network errors are unavailable', async () => {
    expect(await new GooglePlayIntegrityDecoder(account(), fakeFetch({ status: 400 }).impl).decode('ai.aramo.sign', 't')).toEqual({ kind: 'rejected' });
    for (const status of [401, 403, 429, 500, 503]) {
      expect(await new GooglePlayIntegrityDecoder(account(), fakeFetch({ status }).impl).decode('ai.aramo.sign', 't')).toEqual({ kind: 'unavailable' });
    }
    expect(await new GooglePlayIntegrityDecoder(account(), fakeFetch(new TypeError('fetch failed')).impl).decode('ai.aramo.sign', 't')).toEqual({ kind: 'unavailable' });
  });

  it('a failing or malformed OAuth exchange is unavailable and nothing is decoded', async () => {
    for (const token of [{ status: 500 }, { status: 400 }, { status: 200, body: { access_token: '' } }, { status: 200, body: {} }]) {
      const f = fakeFetch({ status: 200, body: { tokenPayloadExternal: {} } }, token);
      expect(await new GooglePlayIntegrityDecoder(account(), f.impl).decode('ai.aramo.sign', 't')).toEqual({ kind: 'unavailable' });
      expect(f.calls.some((c) => c.url !== GOOGLE_OAUTH_TOKEN_URL)).toBe(false);
    }
    const bad = new GooglePlayIntegrityDecoder({ client_email: 'x@y', private_key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }, fakeFetch({ status: 200 }).impl);
    expect(await bad.decode('ai.aramo.sign', 't')).toEqual({ kind: 'unavailable' });
  });
});

describe('env binding and no bypass (§5)', () => {
  let creds: string;
  beforeAll(async () => {
    const kp = await generateKeyPair('RS256', { extractable: true });
    creds = Buffer.from(JSON.stringify({ type: 'service_account', client_email: 'd@p.iam.gserviceaccount.com', private_key: await exportPKCS8(kp.privateKey), private_key_id: 'k' })).toString('base64');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('configured: the Play Integrity check with the Google decoder, defaults package ai.aramo.sign and 300 s', () => {
    const c = nativeIntegrityCheckFromEnv({ SIGN_PLAY_INTEGRITY_CERT_SHA256: APP_SIGNING, SIGN_PLAY_INTEGRITY_CREDENTIALS_B64: creds });
    expect(c).toBeInstanceOf(PlayIntegrityCheck);
    expect((c as PlayIntegrityCheck).decoder).toBeInstanceOf(GooglePlayIntegrityDecoder);
    expect((c as PlayIntegrityCheck).config).toEqual({ package_name: 'ai.aramo.sign', certificate_sha256_hex: APP_SIGNING_HEX, max_age_seconds: 300 });
    const c2 = nativeIntegrityCheckFromEnv({ SIGN_PLAY_INTEGRITY_CERT_SHA256: APP_SIGNING, SIGN_PLAY_INTEGRITY_CREDENTIALS_B64: creds, SIGN_PLAY_INTEGRITY_MAX_AGE_SECONDS: '120', SIGN_PLAY_INTEGRITY_PACKAGE: 'ai.aramo.sign.dev' });
    expect((c2 as PlayIntegrityCheck).config).toEqual({ package_name: 'ai.aramo.sign.dev', certificate_sha256_hex: APP_SIGNING_HEX, max_age_seconds: 120 });
  });

  it.each([
    ['nothing set', {}],
    ['no certificate', { SIGN_PLAY_INTEGRITY_CREDENTIALS_B64: 'CREDS' }],
    ['no credentials', { SIGN_PLAY_INTEGRITY_CERT_SHA256: APP_SIGNING }],
    ['a short certificate', { SIGN_PLAY_INTEGRITY_CERT_SHA256: 'E2:A5', SIGN_PLAY_INTEGRITY_CREDENTIALS_B64: 'CREDS' }],
    ['credentials that are not a service account', { SIGN_PLAY_INTEGRITY_CERT_SHA256: APP_SIGNING, SIGN_PLAY_INTEGRITY_CREDENTIALS_B64: Buffer.from('{"a":1}').toString('base64') }],
    ['an invalid max age', { SIGN_PLAY_INTEGRITY_CERT_SHA256: APP_SIGNING, SIGN_PLAY_INTEGRITY_CREDENTIALS_B64: 'CREDS', SIGN_PLAY_INTEGRITY_MAX_AGE_SECONDS: '0' }],
    ['the Turnstile test mode (never applies to the native check)', { SIGN_TURNSTILE_MODE: 'test' }],
  ])('%s → unconfigured → unavailable (every Android signup refused)', async (_label, env) => {
    const resolved = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === 'CREDS' ? creds : v]));
    const c = nativeIntegrityCheckFromEnv(resolved);
    expect(c).toBeInstanceOf(UnconfiguredNativeIntegrityCheck);
    expect(await c.verify({ token: 'tok', request_hash: HASH, now: NOW })).toEqual({ verdict: 'unavailable', reason: 'not_configured' });
  });

  it('parseServiceAccount reads client_email + private_key (+ key id) from base64 JSON', () => {
    expect(parseServiceAccount(creds)).toMatchObject({ client_email: 'd@p.iam.gserviceaccount.com', private_key_id: 'k' });
    expect(parseServiceAccount('%%%')).toBeNull();
    expect(parseServiceAccount(undefined)).toBeNull();
  });

  it('the production module (IdentityCoreModule) binds NATIVE_INTEGRITY_CHECK to the env factory with the real Google decoder', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, IdentityCoreModule) ?? []) as unknown[];
    const binding = providers.find((p) => typeof p === 'object' && p !== null && (p as { provide?: unknown }).provide === NATIVE_INTEGRITY_CHECK) as
      | { useFactory?: () => unknown; useValue?: unknown; useClass?: unknown }
      | undefined;
    expect(binding).toBeDefined();
    expect(binding!.useValue).toBeUndefined();
    expect(binding!.useClass).toBeUndefined();
    expect(typeof binding!.useFactory).toBe('function');
    const exportsList = (Reflect.getMetadata(MODULE_METADATA.EXPORTS, IdentityCoreModule) ?? []) as unknown[];
    expect(exportsList).toContain(NATIVE_INTEGRITY_CHECK);

    // Apple Go-Live R-9 — the binding routes by platform; the android side is this check.
    vi.stubEnv('SIGN_PLAY_INTEGRITY_CERT_SHA256', APP_SIGNING);
    vi.stubEnv('SIGN_PLAY_INTEGRITY_CREDENTIALS_B64', creds);
    const bound = binding!.useFactory!() as PlatformNativeIntegrityCheck;
    expect(bound).toBeInstanceOf(PlatformNativeIntegrityCheck);
    expect(bound.android).toBeInstanceOf(PlayIntegrityCheck);
    expect((bound.android as PlayIntegrityCheck).decoder).toBeInstanceOf(GooglePlayIntegrityDecoder);

    vi.stubEnv('SIGN_PLAY_INTEGRITY_CREDENTIALS_B64', '');
    expect((binding!.useFactory!() as PlatformNativeIntegrityCheck).android).toBeInstanceOf(UnconfiguredNativeIntegrityCheck);
  });
});
