import { X509Certificate, createHash, timingSafeEqual } from 'node:crypto';

import { Logger } from '@nestjs/common';

import { CborError, decodeCbor, type CborValue } from './cbor.js';
import {
  PlatformNativeIntegrityCheck,
  UnconfiguredNativeIntegrityCheck,
  nativeIntegrityCheckFromEnv,
  type NativeIntegrityCheck,
  type NativeIntegrityInput,
  type NativeIntegrityResult,
} from './native-integrity.port.js';

// Aramo Sign Apple Platform Go-Live (LOCKED) R-9 — iPhone native signup integrity
// through Apple App Attest. One attestation per signup, with no stored keys and no
// assertions: the app generates a key and attests it with clientDataHash = the
// requestHash bytes (the same canonical body hash as Android, M-A11 §2.1 (1)) and
// sends `integrity_token = base64url(JSON {key_id, attestation})`.
//
// The server verifies (Apple, "Validating apps that connect to your server"):
//   1. the x5c chain (credential certificate → intermediate) to the embedded Apple
//      App Attestation Root CA, each certificate valid now;
//   2–4. nonce = SHA-256(authData ‖ clientDataHash) equals the octet string of the
//      credential certificate extension 1.2.840.113635.100.8.2;
//   5. key_id = SHA-256(the credential public key, uncompressed point);
//   6. rpIdHash = SHA-256(SIGN_APP_ATTEST_APP_ID, "<TEAMID>.ai.aramo.sign");
//   7. counter 0;
//   8. aaguid `appattest` + 7 zero bytes (production), or `appattestdevelop` only
//      when SIGN_APP_ATTEST_ALLOW_DEVELOP=1;
//   9. the credential id in authData equals key_id.
// The receipt is not used (no fraud-metric calls). Verdicts keep the robot-check
// semantics of the port: any failed check is `fail`; an unset SIGN_APP_ATTEST_APP_ID
// is `unavailable` (fail closed, refused neutrally like Android). There is no
// setting that accepts an unverified attestation. Replay: a pass returns the key id,
// which the signup row stores in a UNIQUE column (accepted once).
// Only reason codes are logged — never the token or the attestation.

/**
 * Apple App Attestation Root CA (public), from
 * https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem
 * (fetched 2026-11-08). CN=Apple App Attestation Root CA, O=Apple Inc., ST=California;
 * valid 2020-03-18 → 2045-03-15. SHA-256 fingerprint (DER):
 * 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32
 */
export const APPLE_APP_ATTESTATION_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----
`;
export const APPLE_APP_ATTESTATION_ROOT_CA_SHA256 = '1cb9823ba28ba6ad2d33a006941de2ae4f513ef1d4e831b9f7e0fa7b6242c932';

/** DER of the OID 1.2.840.113635.100.8.2 (the App Attest nonce extension). */
export const APP_ATTEST_NONCE_OID_DER = Buffer.from('06092a864886f763640802', 'hex');
/** aaguid: `appattest` + 7 zero bytes (production) / `appattestdevelop` (development). */
export const APP_ATTEST_AAGUID_PRODUCTION = Buffer.concat([Buffer.from('appattest', 'ascii'), Buffer.alloc(7)]);
export const APP_ATTEST_AAGUID_DEVELOP = Buffer.from('appattestdevelop', 'ascii');

const MAX_TOKEN_LENGTH = 32_768;
const sha256 = (...parts: Buffer[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);

// ── DER: the nonce extension of the credential certificate ───────────────────

interface Tlv {
  tag: number;
  start: number;
  end: number;
  next: number;
}

function readTlv(buf: Buffer, off: number): Tlv | null {
  if (off + 2 > buf.length) return null;
  const tag = buf[off]!;
  if ((tag & 0x1f) === 0x1f) return null; // multi-byte tags do not occur in X.509
  let len = buf[off + 1]!;
  let at = off + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || at + n > buf.length) return null;
    len = 0;
    for (let i = 0; i < n; i += 1) len = len * 256 + buf[at + i]!;
    at += n;
  }
  if (at + len > buf.length) return null;
  return { tag, start: at, end: at + len, next: at + len };
}

function children(buf: Buffer, t: Tlv): Tlv[] | null {
  const out: Tlv[] = [];
  let at = t.start;
  while (at < t.end) {
    const c = readTlv(buf, at);
    if (c === null || c.end > t.end) return null;
    out.push(c);
    at = c.next;
  }
  return out;
}

/**
 * The 32-byte nonce from extension 1.2.840.113635.100.8.2 of a DER certificate:
 * Extension ::= SEQUENCE { extnID OID, critical BOOLEAN OPTIONAL, extnValue OCTET STRING }
 * whose extnValue holds SEQUENCE { [1] EXPLICIT OCTET STRING nonce }. Null when absent.
 */
export function appAttestNonceFromCertificate(der: Buffer): Buffer | null {
  const walk = (t: Tlv, depth: number): Buffer | null => {
    if (depth > 12 || (t.tag & 0x20) === 0) return null;
    const kids = children(der, t);
    if (kids === null) return null;
    const first = kids[0];
    if (t.tag === 0x30 && first !== undefined && first.tag === 0x06 && same(der.subarray(first.start - 2, first.end), APP_ATTEST_NONCE_OID_DER)) {
      const value = kids[kids.length - 1]!;
      if (value.tag !== 0x04) return null;
      const seq = readTlv(der, value.start);
      if (seq === null || seq.tag !== 0x30) return null;
      for (const c of children(der, seq) ?? []) {
        if (c.tag !== 0xa1) continue;
        const oct = readTlv(der, c.start);
        if (oct !== null && oct.tag === 0x04 && oct.end <= c.end) return Buffer.from(der.subarray(oct.start, oct.end));
      }
      return null;
    }
    for (const k of kids) {
      const hit = walk(k, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  };
  const root = readTlv(der, 0);
  return root === null ? null : walk(root, 0);
}

// ── the attestation token ────────────────────────────────────────────────────

function b64(v: unknown): Buffer | null {
  if (typeof v !== 'string' || v === '' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
  // Node's base64 decoder reads both the standard and the url-safe alphabet.
  return Buffer.from(v, 'base64');
}

function mapGet(m: CborValue, key: string): CborValue {
  return m instanceof Map ? m.get(key) : undefined;
}

/** The decoded `integrity_token` of a `client: "ios"` start, or null when malformed. */
export function decodeAppAttestToken(token: string): { key_id: Buffer; x5c: Buffer[]; auth_data: Buffer } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token.trim(), 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const key_id = b64((parsed as Record<string, unknown>)['key_id']);
  const attestation = b64((parsed as Record<string, unknown>)['attestation']);
  if (key_id === null || key_id.length !== 32 || attestation === null) return null;
  let obj: CborValue;
  try {
    obj = decodeCbor(attestation);
  } catch (err) {
    if (err instanceof CborError) return null;
    throw err;
  }
  if (mapGet(obj, 'fmt') !== 'apple-appattest') return null;
  const stmt = mapGet(obj, 'attStmt');
  const x5c = mapGet(stmt, 'x5c');
  const auth_data = mapGet(obj, 'authData');
  if (!Array.isArray(x5c) || x5c.length < 2 || !x5c.every((c) => Buffer.isBuffer(c)) || !Buffer.isBuffer(auth_data)) return null;
  return { key_id, x5c: x5c as Buffer[], auth_data };
}

// ── the checks ───────────────────────────────────────────────────────────────

export interface AppAttestConfig {
  /** `<TEAMID>.<bundle id>` — SIGN_APP_ATTEST_APP_ID. */
  app_id: string;
  /** SIGN_APP_ATTEST_ALLOW_DEVELOP=1 — also accept the development aaguid. */
  allow_develop: boolean;
  /** The trust anchor; the embedded Apple root unless a test injects its own. */
  root_pem?: string;
}

function validAt(c: X509Certificate, now: Date): boolean {
  const t = now.getTime();
  return new Date(c.validFrom).getTime() <= t && t <= new Date(c.validTo).getTime();
}

/** Every R-9 check on a decoded attestation. Pure (given `now`). */
export function evaluateAppAttestation(
  att: { key_id: Buffer; x5c: Buffer[]; auth_data: Buffer },
  want: { client_data_hash: Buffer; app_id: string; allow_develop: boolean; root: X509Certificate; now: Date },
): NativeIntegrityResult {
  // 1. The chain: credential certificate ← intermediate ← the Apple root.
  let leaf: X509Certificate;
  let intermediate: X509Certificate;
  try {
    leaf = new X509Certificate(att.x5c[0]!);
    intermediate = new X509Certificate(att.x5c[1]!);
  } catch {
    return { verdict: 'fail', reason: 'attestation_malformed' };
  }
  const chained =
    intermediate.ca &&
    intermediate.checkIssued(want.root) &&
    intermediate.verify(want.root.publicKey) &&
    leaf.checkIssued(intermediate) &&
    leaf.verify(intermediate.publicKey) &&
    validAt(want.root, want.now) &&
    validAt(intermediate, want.now) &&
    validAt(leaf, want.now);
  if (!chained) return { verdict: 'fail', reason: 'certificate_chain_invalid' };

  // 2–4. nonce = SHA-256(authData ‖ clientDataHash) = the certificate's extension.
  const nonce = appAttestNonceFromCertificate(Buffer.from(leaf.raw));
  if (nonce === null || !same(nonce, sha256(att.auth_data, want.client_data_hash))) return { verdict: 'fail', reason: 'nonce_mismatch' };

  // 5. key_id = SHA-256(the credential public key as an uncompressed P-256 point).
  const jwk = leaf.publicKey.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    return { verdict: 'fail', reason: 'key_id_mismatch' };
  }
  const point = Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  if (!same(sha256(point), att.key_id)) return { verdict: 'fail', reason: 'key_id_mismatch' };

  // authData: rpIdHash(32) flags(1) signCount(4) aaguid(16) credIdLen(2) credId …
  const a = att.auth_data;
  if (a.length < 55 || (a[32]! & 0x40) === 0) return { verdict: 'fail', reason: 'attestation_malformed' };
  // 6. rpIdHash.
  if (!same(a.subarray(0, 32), sha256(Buffer.from(want.app_id, 'utf8')))) return { verdict: 'fail', reason: 'rp_id_mismatch' };
  // 7. counter 0.
  if (a.readUInt32BE(33) !== 0) return { verdict: 'fail', reason: 'counter_nonzero' };
  // 8. aaguid.
  const aaguid = a.subarray(37, 53);
  if (!same(aaguid, APP_ATTEST_AAGUID_PRODUCTION) && !(want.allow_develop && same(aaguid, APP_ATTEST_AAGUID_DEVELOP))) {
    return { verdict: 'fail', reason: 'aaguid_mismatch' };
  }
  // 9. credentialId = key_id.
  const len = a.readUInt16BE(53);
  if (a.length < 55 + len || !same(a.subarray(55, 55 + len), att.key_id)) return { verdict: 'fail', reason: 'key_id_mismatch' };

  return { verdict: 'pass', reason: 'ok', attest_key_id: att.key_id.toString('hex') };
}

/** The App Attest check (client ios). */
export class AppAttestCheck implements NativeIntegrityCheck {
  private readonly logger = new Logger('AppAttestCheck');
  private readonly root: X509Certificate;

  constructor(readonly config: AppAttestConfig) {
    this.root = new X509Certificate(config.root_pem ?? APPLE_APP_ATTESTATION_ROOT_CA_PEM);
  }

  async verify(input: NativeIntegrityInput): Promise<NativeIntegrityResult> {
    const result = this.check(input);
    if (result.verdict !== 'pass') this.logger.warn(`native integrity (ios) ${result.verdict}: ${result.reason}`);
    return result;
  }

  private check(input: NativeIntegrityInput): NativeIntegrityResult {
    const token = input.token;
    if (token === null || token.trim() === '' || token.length > MAX_TOKEN_LENGTH) return { verdict: 'fail', reason: 'token_missing' };
    if (!/^[0-9a-f]{64}$/.test(input.request_hash)) return { verdict: 'fail', reason: 'request_hash_mismatch' };
    const att = decodeAppAttestToken(token);
    if (att === null) return { verdict: 'fail', reason: 'attestation_malformed' };
    return evaluateAppAttestation(att, {
      client_data_hash: Buffer.from(input.request_hash, 'hex'),
      app_id: this.config.app_id,
      allow_develop: this.config.allow_develop,
      root: this.root,
      now: input.now ?? new Date(),
    });
  }
}

/**
 * The iOS binding. SIGN_APP_ATTEST_APP_ID (`<TEAMID>.<bundle id>`) is required;
 * unset or invalid → unconfigured (every iOS signup refused, fail closed).
 * SIGN_APP_ATTEST_ALLOW_DEVELOP=1 also accepts the development environment.
 */
export function appAttestCheckFromEnv(env: NodeJS.ProcessEnv = process.env): NativeIntegrityCheck {
  const app_id = env['SIGN_APP_ATTEST_APP_ID']?.trim() ?? '';
  if (app_id === '') return new UnconfiguredNativeIntegrityCheck('app_attest_app_id_not_configured');
  if (!/^[A-Z0-9]{10}\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app_id)) return new UnconfiguredNativeIntegrityCheck('app_attest_app_id_invalid');
  return new AppAttestCheck({ app_id, allow_develop: env['SIGN_APP_ATTEST_ALLOW_DEVELOP']?.trim() === '1' });
}

/** The production binding of NATIVE_INTEGRITY_CHECK: android → Play Integrity, ios → App Attest. */
export function nativeIntegrityChecksFromEnv(env: NodeJS.ProcessEnv = process.env): PlatformNativeIntegrityCheck {
  return new PlatformNativeIntegrityCheck(nativeIntegrityCheckFromEnv(env), appAttestCheckFromEnv(env));
}
