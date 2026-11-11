import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  APPLE_APP_ATTESTATION_ROOT_CA_PEM,
  APPLE_APP_ATTESTATION_ROOT_CA_SHA256,
  APP_ATTEST_AAGUID_DEVELOP,
  APP_ATTEST_AAGUID_PRODUCTION,
  AppAttestCheck,
  appAttestCheckFromEnv,
  appAttestNonceFromCertificate,
  nativeIntegrityChecksFromEnv,
} from '../lib/personal/app-attest.js';
import { CborError, decodeCbor, decodeCborItem } from '../lib/personal/cbor.js';
import {
  PlatformNativeIntegrityCheck,
  UnconfiguredNativeIntegrityCheck,
  nativeSignupRequestHash,
  type NativeIntegrityCheck,
  type NativeIntegrityInput,
  type NativeIntegrityResult,
} from '../lib/personal/native-integrity.port.js';

// Aramo Sign Apple Platform Go-Live (LOCKED) R-9 — the App Attest verifier: the embedded
// Apple root (fingerprint), the minimal CBOR decoder, and every check positive and
// negative against a synthetic chain (own root → intermediate → credential certificate
// carrying the nonce extension), the root being injectable. Replay (a key id accepted
// once) is the signup row's UNIQUE column: apps/platform-admin personal-signup-native.spec.

const sha256 = (...parts: Buffer[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

// ── a minimal DER writer (test-only certificates) ────────────────────────────

function tlv(tag: number, content: Buffer): Buffer {
  const n = content.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, content]);
}
const seq = (...c: Buffer[]) => tlv(0x30, Buffer.concat(c));
const set = (...c: Buffer[]) => tlv(0x31, Buffer.concat(c));
const explicit = (n: number, c: Buffer) => tlv(0xa0 + n, c);
const octet = (c: Buffer) => tlv(0x04, c);
const bool = (v: boolean) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const int = (v: Buffer) => tlv(0x02, v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
function oid(dotted: string): Buffer {
  const arcs = dotted.split('.').map(Number);
  const out = [40 * arcs[0]! + arcs[1]!];
  for (const a of arcs.slice(2)) {
    const b: number[] = [a & 0x7f];
    for (let v = Math.floor(a / 128); v > 0; v = Math.floor(v / 128)) b.unshift((v & 0x7f) | 0x80);
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/**
 * A random positive serial in minimal DER form: a leading 0x00 byte (non-minimal INTEGER) makes the
 * X509 parser reject the certificate, which made this suite fail intermittently (≈1 run in 8).
 */
function serialNumber(): Buffer {
  const b = randomBytes(8);
  b[0] = (b[0]! & 0x7f) | 0x01;
  return b;
}

function certificate(o: { subject: string; issuer: string; key: KeyObject; issuerKey: KeyObject; ca: boolean; nonce?: Buffer; notBefore?: Date; notAfter?: Date }): Buffer {
  const exts: Buffer[] = [seq(oid('2.5.29.19'), bool(true), octet(seq(...(o.ca ? [bool(true)] : []))))];
  if (o.nonce !== undefined) exts.push(seq(oid('1.2.840.113635.100.8.2'), octet(seq(tlv(0xa1, octet(o.nonce))))));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(serialNumber()),
    ECDSA_SHA256,
    name(o.issuer),
    seq(utc(o.notBefore ?? new Date('2026-01-01T00:00:00Z')), utc(o.notAfter ?? new Date('2030-01-01T00:00:00Z'))),
    name(o.subject),
    o.key.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...exts)),
  );
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, o.issuerKey)])));
}

// ── a minimal CBOR writer (test-only attestation objects) ────────────────────

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}
type Enc = number | string | Buffer | Enc[] | Map<number | string, Enc>;
function cbor(v: Enc): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v, 'utf8')]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

// ── the synthetic chain and attestation ──────────────────────────────────────

const APP_ID = 'ABCDE12345.ai.aramo.sign';
const NOW = new Date('2026-11-08T12:00:00Z');
const BODY = { client: 'ios', name: 'Pat Person', email: 'pat.person@gmail.com', phone: '+12025550101', residence: 'US', invite_code: null, hp: '', elapsed_ms: 20_000 };
const HASH = nativeSignupRequestHash(BODY);

const ec = () => generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rootKeys = ec();
const intKeys = ec();
const ROOT_DER = certificate({ subject: 'Test Attestation Root', issuer: 'Test Attestation Root', key: rootKeys.publicKey, issuerKey: rootKeys.privateKey, ca: true });
const ROOT_PEM = new X509Certificate(ROOT_DER).toString();
const INT_DER = certificate({ subject: 'Test Attestation CA 1', issuer: 'Test Attestation Root', key: intKeys.publicKey, issuerKey: rootKeys.privateKey, ca: true });

interface Build {
  request_hash?: string;
  app_id?: string;
  counter?: number;
  aaguid?: Buffer;
  /** The key id the token claims (default: the real one). */
  token_key_id?: Buffer;
  /** The credential id in authData (default: the real key id). */
  credential_id?: Buffer;
  /** A nonce to embed instead of the correct one. */
  nonce?: Buffer;
  intermediate?: Buffer;
  issuerKey?: KeyObject;
  leafNotAfter?: Date;
  fmt?: string;
}

function attest(b: Build = {}): { token: string; key_id: Buffer } {
  const leafKeys = ec();
  const jwk = leafKeys.publicKey.export({ format: 'jwk' });
  const key_id = sha256(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]));
  const counter = Buffer.alloc(4);
  counter.writeUInt32BE(b.counter ?? 0);
  const cred = b.credential_id ?? key_id;
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(cred.length);
  const cose = cbor(new Map<number, Enc>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
  const authData = Buffer.concat([sha256(Buffer.from(b.app_id ?? APP_ID)), Buffer.from([0x40]), counter, b.aaguid ?? APP_ATTEST_AAGUID_PRODUCTION, credLen, cred, cose]);
  const nonce = b.nonce ?? sha256(authData, Buffer.from(b.request_hash ?? HASH, 'hex'));
  const leaf = certificate({
    subject: key_id.toString('hex'),
    issuer: 'Test Attestation CA 1',
    key: leafKeys.publicKey,
    issuerKey: b.issuerKey ?? intKeys.privateKey,
    ca: false,
    nonce,
    ...(b.leafNotAfter === undefined ? {} : { notAfter: b.leafNotAfter }),
  });
  const attestation = cbor(
    new Map<string, Enc>([
      ['fmt', b.fmt ?? 'apple-appattest'],
      ['attStmt', new Map<string, Enc>([['x5c', [leaf, b.intermediate ?? INT_DER]], ['receipt', randomBytes(64)]])],
      ['authData', authData],
    ]),
  );
  const token = Buffer.from(JSON.stringify({ key_id: (b.token_key_id ?? key_id).toString('base64'), attestation: attestation.toString('base64') })).toString('base64url');
  return { token, key_id };
}

const check = (o: { allow_develop?: boolean; app_id?: string } = {}) =>
  new AppAttestCheck({ app_id: o.app_id ?? APP_ID, allow_develop: o.allow_develop ?? false, root_pem: ROOT_PEM });
const verify = (c: AppAttestCheck, token: string | null, request_hash = HASH) => c.verify({ platform: 'ios', token, request_hash, now: NOW });

// ── tests ────────────────────────────────────────────────────────────────────

describe('the embedded Apple App Attestation Root CA', () => {
  it('is the published certificate (SHA-256 fingerprint of the DER)', () => {
    const root = new X509Certificate(APPLE_APP_ATTESTATION_ROOT_CA_PEM);
    expect(createHash('sha256').update(root.raw).digest('hex')).toBe(APPLE_APP_ATTESTATION_ROOT_CA_SHA256);
    expect(root.fingerprint256.replace(/:/g, '').toLowerCase()).toBe('1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932');
    expect(root.subject).toContain('CN=Apple App Attestation Root CA');
    expect(root.ca).toBe(true);
  });

  it('is the default trust anchor: a synthetic chain does not verify against it', async () => {
    const real = new AppAttestCheck({ app_id: APP_ID, allow_develop: false });
    expect(await verify(real, attest().token)).toEqual({ verdict: 'fail', reason: 'certificate_chain_invalid' });
  });
});

describe('the minimal CBOR decoder', () => {
  it('reads integers of every width, negatives, byte / text strings, arrays, maps, tags and simple values', () => {
    expect(decodeCbor(Buffer.from('17', 'hex'))).toBe(23);
    expect(decodeCbor(Buffer.from('1818', 'hex'))).toBe(24);
    expect(decodeCbor(Buffer.from('190100', 'hex'))).toBe(256);
    expect(decodeCbor(Buffer.from('1a000f4240', 'hex'))).toBe(1_000_000);
    expect(decodeCbor(Buffer.from('1b000000e8d4a51000', 'hex'))).toBe(1_000_000_000_000);
    expect(decodeCbor(Buffer.from('26', 'hex'))).toBe(-7);
    expect(decodeCbor(Buffer.from('3863', 'hex'))).toBe(-100);
    expect(decodeCbor(Buffer.from('4401020304', 'hex'))).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(decodeCbor(Buffer.from('6449455446', 'hex'))).toBe('IETF');
    expect(decodeCbor(Buffer.from('83010203', 'hex'))).toEqual([1, 2, 3]);
    expect(decodeCbor(Buffer.from('f4', 'hex'))).toBe(false);
    expect(decodeCbor(Buffer.from('f6', 'hex'))).toBeNull();
    expect(decodeCborItem(Buffer.from('f5f6', 'hex'))).toEqual({ value: true, end: 1 });
    expect(decodeCbor(Buffer.from('c11a514b67b0', 'hex'))).toBe(1363896240);
    const m = decodeCbor(cbor(new Map<number | string, Enc>([['a', 1], [-1, [2, 'x']]]))) as Map<unknown, unknown>;
    expect(m.get('a')).toBe(1);
    expect(m.get(-1)).toEqual([2, 'x']);
  });

  it.each([
    ['truncated', '4401'],
    ['trailing bytes', '0101'],
    ['indefinite length', '5f4101ff'],
    ['a float', 'fa47c35000'],
    ['an integer beyond 2^53 - 1', '1bffffffffffffffff'],
    ['a duplicate map key', 'a2616101616102'],
    ['a byte-string map key', 'a1410101'],
    ['an array longer than the input', '9a7fffffff'],
  ])('refuses %s', (_l, hex) => {
    expect(() => decodeCbor(Buffer.from(hex, 'hex'))).toThrow(CborError);
  });

  it('refuses nesting deeper than its limit', () => {
    expect(() => decodeCbor(Buffer.concat([Buffer.alloc(40, 0x81), Buffer.from([0x01])]))).toThrow(CborError);
  });
});

describe('AppAttestCheck — every R-9 check (synthetic chain, injected root)', () => {
  it('passes a valid attestation and reports the key id (lowercase hex) for the replay column', async () => {
    const { token, key_id } = attest();
    expect(await verify(check(), token)).toEqual({ verdict: 'pass', reason: 'ok', attest_key_id: key_id.toString('hex') });
  });

  it('reads the nonce extension 1.2.840.113635.100.8.2 from the credential certificate', () => {
    const nonce = randomBytes(32);
    const k = ec();
    const der = certificate({ subject: 'x', issuer: 'x', key: k.publicKey, issuerKey: k.privateKey, ca: false, nonce });
    expect(appAttestNonceFromCertificate(der)).toEqual(nonce);
    expect(appAttestNonceFromCertificate(INT_DER)).toBeNull();
  });

  it('wrong nonce: the attestation was made for another request body', async () => {
    const other = nativeSignupRequestHash({ ...BODY, phone: '+12025550199' });
    expect(await verify(check(), attest().token, other)).toEqual({ verdict: 'fail', reason: 'nonce_mismatch' });
    expect(await verify(check(), attest({ nonce: randomBytes(32) }).token)).toEqual({ verdict: 'fail', reason: 'nonce_mismatch' });
  });

  it('wrong rpId: another app id (team or bundle)', async () => {
    expect(await verify(check(), attest({ app_id: 'ZZZZZ99999.ai.aramo.sign' }).token)).toEqual({ verdict: 'fail', reason: 'rp_id_mismatch' });
    expect(await verify(check({ app_id: 'ABCDE12345.ai.aramo.other' }), attest().token)).toEqual({ verdict: 'fail', reason: 'rp_id_mismatch' });
  });

  it('the development aaguid is refused unless SIGN_APP_ATTEST_ALLOW_DEVELOP; any other aaguid always', async () => {
    const dev = attest({ aaguid: APP_ATTEST_AAGUID_DEVELOP });
    expect(await verify(check(), dev.token)).toEqual({ verdict: 'fail', reason: 'aaguid_mismatch' });
    expect(await verify(check({ allow_develop: true }), dev.token)).toMatchObject({ verdict: 'pass', attest_key_id: dev.key_id.toString('hex') });
    expect(await verify(check({ allow_develop: true }), attest({ aaguid: Buffer.alloc(16) }).token)).toEqual({ verdict: 'fail', reason: 'aaguid_mismatch' });
    expect(APP_ATTEST_AAGUID_PRODUCTION).toEqual(Buffer.from('617070617474657374' + '00'.repeat(7), 'hex'));
  });

  it('counter ≠ 0 fails', async () => {
    expect(await verify(check(), attest({ counter: 1 }).token)).toEqual({ verdict: 'fail', reason: 'counter_nonzero' });
  });

  it('key_id mismatch: the token claims another key, or authData carries another credential id', async () => {
    expect(await verify(check(), attest({ token_key_id: randomBytes(32) }).token)).toEqual({ verdict: 'fail', reason: 'key_id_mismatch' });
    expect(await verify(check(), attest({ credential_id: randomBytes(32) }).token)).toEqual({ verdict: 'fail', reason: 'key_id_mismatch' });
  });

  it('the chain must reach the trust anchor and be valid now', async () => {
    const strangerRoot = ec();
    const foreignInt = certificate({ subject: 'Test Attestation CA 1', issuer: 'Test Attestation Root', key: intKeys.publicKey, issuerKey: strangerRoot.privateKey, ca: true });
    expect(await verify(check(), attest({ intermediate: foreignInt }).token)).toEqual({ verdict: 'fail', reason: 'certificate_chain_invalid' });
    expect(await verify(check(), attest({ issuerKey: ec().privateKey }).token)).toEqual({ verdict: 'fail', reason: 'certificate_chain_invalid' });
    expect(await verify(check(), attest({ leafNotAfter: new Date('2026-11-01T00:00:00Z') }).token)).toEqual({ verdict: 'fail', reason: 'certificate_chain_invalid' });
    const notCa = certificate({ subject: 'Test Attestation CA 1', issuer: 'Test Attestation Root', key: intKeys.publicKey, issuerKey: rootKeys.privateKey, ca: false });
    expect(await verify(check(), attest({ intermediate: notCa }).token)).toEqual({ verdict: 'fail', reason: 'certificate_chain_invalid' });
  });

  it('a missing, oversized or malformed token fails (never unavailable)', async () => {
    expect(await verify(check(), null)).toEqual({ verdict: 'fail', reason: 'token_missing' });
    expect(await verify(check(), '  ')).toEqual({ verdict: 'fail', reason: 'token_missing' });
    expect(await verify(check(), 'x'.repeat(40_000))).toEqual({ verdict: 'fail', reason: 'token_missing' });
    expect(await verify(check(), 'not-json')).toEqual({ verdict: 'fail', reason: 'attestation_malformed' });
    expect(await verify(check(), Buffer.from(JSON.stringify({ key_id: 'AAAA', attestation: 'oA' })).toString('base64url'))).toEqual({ verdict: 'fail', reason: 'attestation_malformed' });
    expect(await verify(check(), attest({ fmt: 'packed' }).token)).toEqual({ verdict: 'fail', reason: 'attestation_malformed' });
    expect(await verify(check(), attest().token, 'not-a-hash')).toEqual({ verdict: 'fail', reason: 'request_hash_mismatch' });
  });
});

describe('env binding and platform routing (R-9)', () => {
  it.each([
    ['nothing set', {}],
    ['an empty app id', { SIGN_APP_ATTEST_APP_ID: ' ' }],
    ['an app id without a team id', { SIGN_APP_ATTEST_APP_ID: 'ai.aramo.sign' }],
    ['develop alone', { SIGN_APP_ATTEST_ALLOW_DEVELOP: '1' }],
  ])('%s → unconfigured → unavailable (every iOS signup refused, fail closed)', async (_l, env) => {
    const c = appAttestCheckFromEnv(env);
    expect(c).toBeInstanceOf(UnconfiguredNativeIntegrityCheck);
    expect(await c.verify({ platform: 'ios', token: attest().token, request_hash: HASH, now: NOW })).toEqual({ verdict: 'unavailable', reason: 'not_configured' });
  });

  it('configured: the embedded Apple root; develop only with exactly 1', () => {
    const c = appAttestCheckFromEnv({ SIGN_APP_ATTEST_APP_ID: APP_ID }) as AppAttestCheck;
    expect(c).toBeInstanceOf(AppAttestCheck);
    expect(c.config).toEqual({ app_id: APP_ID, allow_develop: false });
    expect((appAttestCheckFromEnv({ SIGN_APP_ATTEST_APP_ID: APP_ID, SIGN_APP_ATTEST_ALLOW_DEVELOP: '1' }) as AppAttestCheck).config.allow_develop).toBe(true);
    expect((appAttestCheckFromEnv({ SIGN_APP_ATTEST_APP_ID: APP_ID, SIGN_APP_ATTEST_ALLOW_DEVELOP: 'true' }) as AppAttestCheck).config.allow_develop).toBe(false);
  });

  it('the production binding routes android → Play Integrity and ios → App Attest (absent platform = android)', async () => {
    const both = nativeIntegrityChecksFromEnv({ SIGN_APP_ATTEST_APP_ID: APP_ID });
    expect(both).toBeInstanceOf(PlatformNativeIntegrityCheck);
    expect(both.android).toBeInstanceOf(UnconfiguredNativeIntegrityCheck);
    expect(both.ios).toBeInstanceOf(AppAttestCheck);
    expect(nativeIntegrityChecksFromEnv({}).ios).toBeInstanceOf(UnconfiguredNativeIntegrityCheck);

    const seen: string[] = [];
    const spy = (tag: string): NativeIntegrityCheck => ({
      verify: async (_i: NativeIntegrityInput): Promise<NativeIntegrityResult> => {
        seen.push(tag);
        return { verdict: 'pass', reason: 'ok' };
      },
    });
    const router = new PlatformNativeIntegrityCheck(spy('android'), spy('ios'));
    await router.verify({ platform: 'ios', token: 't', request_hash: HASH });
    await router.verify({ platform: 'android', token: 't', request_hash: HASH });
    await router.verify({ token: 't', request_hash: HASH });
    expect(seen).toEqual(['ios', 'android', 'android']);
  });
});
