import { createHash } from 'node:crypto';

import { Logger } from '@nestjs/common';
import { SignJWT, importPKCS8 } from 'jose';

// Aramo-Sign-Mobile-Amendment-M-A11 (LOCKED) §2 / §2.1 — the native integrity check
// that replaces the robot check (Turnstile) for `start` from `client: "android"`.
// A Play Integrity STANDARD request binds the request with `requestHash` (the
// lowercase hex SHA-256 of the canonical start body, below). platform-admin rebuilds
// the canonical body from what it received, decodes the token through Google's
// decodeIntegrityToken with the app's Cloud service account, and passes only when
// every check of §2.1 holds. Verdicts keep the robot-check semantics:
//   pass         every check holds
//   fail         any check fails (refused by the risk rating: robot_check_failed)
//   unavailable  not configured, or Google unreachable (refused: fail closed)
// There is NO setting that accepts an unverified token (§5 "no bypass"): an
// unconfigured server answers `unavailable`. Test doubles live only in test modules.
// Only reason codes are logged — never the token or the decoded payload.
//
// Aramo Sign Apple Platform Go-Live (LOCKED) R-9 — the port gains a platform
// discriminator: `android` (Play Integrity, above, unchanged) or `ios` (Apple App
// Attest, ./app-attest.ts). The production binding routes by platform
// (PlatformNativeIntegrityCheck); each platform keeps the same verdicts and fails
// closed on its own when unconfigured.

export const NATIVE_INTEGRITY_CHECK = Symbol('NATIVE_INTEGRITY_CHECK');

export type NativeIntegrityVerdict = 'pass' | 'fail' | 'unavailable';

export type NativeIntegrityReason =
  | 'ok'
  | 'not_configured'
  | 'token_missing'
  | 'token_rejected'
  | 'decode_unavailable'
  | 'payload_malformed'
  | 'request_hash_mismatch'
  | 'package_mismatch'
  | 'app_not_recognized'
  | 'certificate_mismatch'
  | 'device_integrity_missing'
  | 'timestamp_invalid'
  | 'timestamp_stale'
  | 'timestamp_future'
  // Apple Go-Live R-9 — App Attest (ios).
  | 'attestation_malformed'
  | 'certificate_chain_invalid'
  | 'nonce_mismatch'
  | 'key_id_mismatch'
  | 'rp_id_mismatch'
  | 'counter_nonzero'
  | 'aaguid_mismatch';

export interface NativeIntegrityResult {
  verdict: NativeIntegrityVerdict;
  reason: NativeIntegrityReason;
  /**
   * Apple Go-Live R-9 — on an App Attest pass, the attested key id (lowercase hex). The
   * caller stores it on the signup row (UNIQUE) so one attestation is accepted once.
   */
  attest_key_id?: string;
}

/** Apple Go-Live R-9 — which native verifier applies. */
export type NativeIntegrityPlatform = 'android' | 'ios';

export interface NativeIntegrityInput {
  /** Absent = `android` (the M-A11 Play Integrity path, unchanged). */
  platform?: NativeIntegrityPlatform;
  token: string | null;
  request_hash: string;
  now?: Date;
}

export interface NativeIntegrityCheck {
  verify(input: NativeIntegrityInput): Promise<NativeIntegrityResult>;
}

/**
 * Apple Go-Live R-9 — the production binding: routes each verification to its
 * platform's verifier (android → Play Integrity, ios → App Attest).
 */
export class PlatformNativeIntegrityCheck implements NativeIntegrityCheck {
  constructor(
    readonly android: NativeIntegrityCheck,
    readonly ios: NativeIntegrityCheck,
  ) {}

  verify(input: NativeIntegrityInput): Promise<NativeIntegrityResult> {
    return (input.platform ?? 'android') === 'ios' ? this.ios.verify(input) : this.android.verify(input);
  }
}

export const SIGN_PLAY_INTEGRITY_DEFAULT_PACKAGE = 'ai.aramo.sign';
export const SIGN_PLAY_INTEGRITY_DEFAULT_MAX_AGE_SECONDS = 300;
/** Allowed future clock skew of the token timestamp. */
export const SIGN_PLAY_INTEGRITY_FUTURE_SKEW_MS = 60_000;
export const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
export const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PLAY_INTEGRITY_DECODE_URL = (packageName: string): string =>
  `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`;

const MAX_TOKEN_LENGTH = 16_384;

// ── §2.1 (1) canonical request ───────────────────────────────────────────────

/** The fields of a native `start` body that are bound by the integrity token, as received. */
export interface NativeSignupCanonicalFields {
  client: unknown;
  name: unknown;
  email: unknown;
  phone: unknown;
  residence: unknown;
  invite_code: unknown;
  hp: unknown;
  elapsed_ms: unknown;
}

/**
 * The canonical form: the UTF-8 JSON array of client, name, email, phone, residence,
 * invite_code (null when absent), hp, elapsed_ms — the values exactly as received
 * (before any trim or normalization), without the token.
 */
export function nativeSignupCanonicalRequest(b: NativeSignupCanonicalFields): string {
  return JSON.stringify([b.client, b.name, b.email, b.phone, b.residence, b.invite_code ?? null, b.hp, b.elapsed_ms]);
}

/** requestHash = lowercase hex SHA-256 of the canonical request. */
export function nativeSignupRequestHash(b: NativeSignupCanonicalFields): string {
  return createHash('sha256').update(nativeSignupCanonicalRequest(b), 'utf8').digest('hex');
}

// ── §2.1 (2) the checks on the decoded payload ───────────────────────────────

export interface PlayIntegrityExpectations {
  request_hash: string;
  package_name: string;
  /** The Play app-signing certificate SHA-256, lowercase hex (64 chars). */
  certificate_sha256_hex: string;
  max_age_ms: number;
  now: Date;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** Google's certificateSha256Digest entries are base64url without padding; hex for comparison. */
export function certificateDigestHex(googleDigest: string): string | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(googleDigest)) return null;
  const hex = Buffer.from(googleDigest, 'base64url').toString('hex');
  return hex.length === 64 ? hex : null;
}

/** Normalizes a configured certificate digest (hex, colons allowed) to 64 lowercase hex, or null. */
export function normalizeCertificateHex(configured: string): string | null {
  const hex = configured.replace(/:/g, '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

/** Every §2.1 check on `tokenPayloadExternal`. Pure. */
export function evaluatePlayIntegrityPayload(payload: unknown, want: PlayIntegrityExpectations): NativeIntegrityResult {
  const p = obj(payload);
  const request = obj(p?.['requestDetails']);
  const app = obj(p?.['appIntegrity']);
  const device = obj(p?.['deviceIntegrity']);
  if (p === null || request === null || app === null) return { verdict: 'fail', reason: 'payload_malformed' };

  if (typeof request['requestHash'] !== 'string' || request['requestHash'] !== want.request_hash) {
    return { verdict: 'fail', reason: 'request_hash_mismatch' };
  }
  if (request['requestPackageName'] !== want.package_name || app['packageName'] !== want.package_name) {
    return { verdict: 'fail', reason: 'package_mismatch' };
  }
  if (app['appRecognitionVerdict'] !== 'PLAY_RECOGNIZED') return { verdict: 'fail', reason: 'app_not_recognized' };
  const digests = strings(app['certificateSha256Digest']).map(certificateDigestHex);
  if (!digests.includes(want.certificate_sha256_hex)) return { verdict: 'fail', reason: 'certificate_mismatch' };
  if (!strings(device?.['deviceRecognitionVerdict']).includes('MEETS_DEVICE_INTEGRITY')) {
    return { verdict: 'fail', reason: 'device_integrity_missing' };
  }
  const raw = request['timestampMillis'];
  const ts = typeof raw === 'string' && /^\d{1,16}$/.test(raw) ? Number(raw) : typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : null;
  if (ts === null) return { verdict: 'fail', reason: 'timestamp_invalid' };
  const now = want.now.getTime();
  if (ts - now > SIGN_PLAY_INTEGRITY_FUTURE_SKEW_MS) return { verdict: 'fail', reason: 'timestamp_future' };
  if (now - ts > want.max_age_ms) return { verdict: 'fail', reason: 'timestamp_stale' };
  return { verdict: 'pass', reason: 'ok' };
}

// ── the Google transport ─────────────────────────────────────────────────────

export type PlayIntegrityDecodeResult =
  | { kind: 'payload'; payload: unknown }
  /** Google refused the token itself (malformed / not for this app): a check failure. */
  | { kind: 'rejected' }
  /** Our credential, Google's availability or the network: fail closed. */
  | { kind: 'unavailable' };

export interface PlayIntegrityDecoder {
  decode(packageName: string, token: string): Promise<PlayIntegrityDecodeResult>;
}

export interface GoogleServiceAccount {
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * decodeIntegrityToken with a service-account access token: an RS256 JWT signed with
 * jose (scope playintegrity) exchanged at Google's OAuth token endpoint; the access
 * token is cached until shortly before it expires.
 */
export class GooglePlayIntegrityDecoder implements PlayIntegrityDecoder {
  private readonly logger = new Logger('PlayIntegrityDecoder');
  private cached: { token: string; expires_at: number } | null = null;

  constructor(
    private readonly account: GoogleServiceAccount,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly clock: () => number = () => Date.now(),
    private readonly timeoutMs = 5000,
  ) {}

  async decode(packageName: string, token: string): Promise<PlayIntegrityDecodeResult> {
    const access = await this.accessToken();
    if (access === null) return { kind: 'unavailable' };
    try {
      const res = await this.fetchImpl(PLAY_INTEGRITY_DECODE_URL(packageName), {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({ integrity_token: token }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) {
        const out = obj(await res.json());
        return { kind: 'payload', payload: out?.['tokenPayloadExternal'] ?? null };
      }
      // 400: the token is not a valid integrity token for this app. Anything else
      // (401/403 our credential, 429, 5xx) is ours or Google's: unavailable.
      if (res.status === 400) return { kind: 'rejected' };
      if (res.status === 401 || res.status === 403) this.cached = null;
      this.logger.warn(`play integrity decode unavailable: http_${res.status}`);
      return { kind: 'unavailable' };
    } catch (err) {
      this.logger.warn(`play integrity decode unavailable: ${(err as Error).name}`);
      return { kind: 'unavailable' };
    }
  }

  private async accessToken(): Promise<string | null> {
    const now = this.clock();
    if (this.cached !== null && this.cached.expires_at > now) return this.cached.token;
    try {
      const key = await importPKCS8(this.account.private_key, 'RS256');
      const iat = Math.floor(now / 1000);
      const assertion = await new SignJWT({ scope: PLAY_INTEGRITY_SCOPE })
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', ...(this.account.private_key_id === undefined ? {} : { kid: this.account.private_key_id }) })
        .setIssuer(this.account.client_email)
        .setAudience(GOOGLE_OAUTH_TOKEN_URL)
        .setIssuedAt(iat)
        .setExpirationTime(iat + 3600)
        .sign(key);
      const res = await this.fetchImpl(GOOGLE_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.logger.warn(`play integrity credential unavailable: http_${res.status}`);
        return null;
      }
      const out = obj(await res.json());
      const token = out?.['access_token'];
      const ttl = typeof out?.['expires_in'] === 'number' ? (out['expires_in'] as number) : 0;
      if (typeof token !== 'string' || token === '' || ttl <= 0) {
        this.logger.warn('play integrity credential unavailable: token_response_malformed');
        return null;
      }
      // Refresh a minute early (never cache a token that is about to lapse).
      this.cached = { token, expires_at: now + Math.max(0, ttl - 60) * 1000 };
      return token;
    } catch (err) {
      this.logger.warn(`play integrity credential unavailable: ${(err as Error).name}`);
      return null;
    }
  }
}

// ── the checks ───────────────────────────────────────────────────────────────

export interface PlayIntegrityConfig {
  package_name: string;
  certificate_sha256_hex: string;
  max_age_seconds: number;
}

/** The Play Integrity Standard check: decode through `decoder`, then every §2.1 check. */
export class PlayIntegrityCheck implements NativeIntegrityCheck {
  private readonly logger = new Logger('PlayIntegrityCheck');

  constructor(
    readonly config: PlayIntegrityConfig,
    readonly decoder: PlayIntegrityDecoder,
  ) {}

  async verify(input: { token: string | null; request_hash: string; now?: Date }): Promise<NativeIntegrityResult> {
    const result = await this.check(input);
    if (result.verdict !== 'pass') this.logger.warn(`native integrity ${result.verdict}: ${result.reason}`);
    return result;
  }

  private async check(input: { token: string | null; request_hash: string; now?: Date }): Promise<NativeIntegrityResult> {
    const token = input.token;
    if (token === null || token.trim() === '' || token.length > MAX_TOKEN_LENGTH) return { verdict: 'fail', reason: 'token_missing' };
    const decoded = await this.decoder.decode(this.config.package_name, token);
    if (decoded.kind === 'unavailable') return { verdict: 'unavailable', reason: 'decode_unavailable' };
    if (decoded.kind === 'rejected') return { verdict: 'fail', reason: 'token_rejected' };
    return evaluatePlayIntegrityPayload(decoded.payload, {
      request_hash: input.request_hash,
      package_name: this.config.package_name,
      certificate_sha256_hex: this.config.certificate_sha256_hex,
      max_age_ms: this.config.max_age_seconds * 1000,
      now: input.now ?? new Date(),
    });
  }
}

/** Not configured: every native signup is refused (fail closed). */
export class UnconfiguredNativeIntegrityCheck implements NativeIntegrityCheck {
  private readonly logger = new Logger('NativeIntegrityCheck');

  constructor(readonly why = 'not_configured') {}

  async verify(): Promise<NativeIntegrityResult> {
    this.logger.warn(`native integrity unavailable: ${this.why}`);
    return { verdict: 'unavailable', reason: 'not_configured' };
  }
}

/** The service-account JSON from SIGN_PLAY_INTEGRITY_CREDENTIALS_B64, or null. */
export function parseServiceAccount(b64: string | undefined): GoogleServiceAccount | null {
  if (b64 === undefined || b64.trim() === '') return null;
  try {
    const o = obj(JSON.parse(Buffer.from(b64.trim(), 'base64').toString('utf8')));
    const client_email = o?.['client_email'];
    const private_key = o?.['private_key'];
    const private_key_id = o?.['private_key_id'];
    if (typeof client_email !== 'string' || client_email === '' || typeof private_key !== 'string' || !private_key.includes('PRIVATE KEY')) return null;
    return { client_email, private_key, ...(typeof private_key_id === 'string' && private_key_id !== '' ? { private_key_id } : {}) };
  } catch {
    return null;
  }
}

/**
 * The production binding. SIGN_PLAY_INTEGRITY_CERT_SHA256 and
 * SIGN_PLAY_INTEGRITY_CREDENTIALS_B64 are required; SIGN_PLAY_INTEGRITY_PACKAGE
 * defaults to ai.aramo.sign and SIGN_PLAY_INTEGRITY_MAX_AGE_SECONDS to 300. Anything
 * missing or invalid → unconfigured (every native signup refused). No value accepts
 * an unverified token.
 */
export function nativeIntegrityCheckFromEnv(env: NodeJS.ProcessEnv = process.env): NativeIntegrityCheck {
  const cert = normalizeCertificateHex(env['SIGN_PLAY_INTEGRITY_CERT_SHA256'] ?? '');
  const account = parseServiceAccount(env['SIGN_PLAY_INTEGRITY_CREDENTIALS_B64']);
  const pkg = env['SIGN_PLAY_INTEGRITY_PACKAGE']?.trim() || SIGN_PLAY_INTEGRITY_DEFAULT_PACKAGE;
  const ageRaw = env['SIGN_PLAY_INTEGRITY_MAX_AGE_SECONDS']?.trim();
  const age = ageRaw === undefined || ageRaw === '' ? SIGN_PLAY_INTEGRITY_DEFAULT_MAX_AGE_SECONDS : /^\d{1,5}$/.test(ageRaw) ? Number(ageRaw) : NaN;
  if (cert === null) return new UnconfiguredNativeIntegrityCheck('certificate_not_configured');
  if (account === null) return new UnconfiguredNativeIntegrityCheck('credentials_not_configured');
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg)) return new UnconfiguredNativeIntegrityCheck('package_invalid');
  if (!Number.isInteger(age) || age <= 0) return new UnconfiguredNativeIntegrityCheck('max_age_invalid');
  return new PlayIntegrityCheck({ package_name: pkg, certificate_sha256_hex: cert, max_age_seconds: age }, new GooglePlayIntegrityDecoder(account));
}
