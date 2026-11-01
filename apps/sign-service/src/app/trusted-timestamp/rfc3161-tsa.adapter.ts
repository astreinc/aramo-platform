import { randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import {
  buildTimeStampRequest,
  verifyTimeStampResponse,
  type TrustedTimestampPort,
  type TrustedTimestampToken,
} from '@aramo/sign';
import { FEATURE_AVAILABILITY, isFeatureAvailable, type FeatureAvailability } from '@aramo/subscription';

// Feature-Parity Directive v1.0 §1.18 — the RFC 3161 HTTP transport (RFC 3161 §3.4):
// POST a DER TimeStampReq (application/timestamp-query) and verify the DER
// TimeStampResp before anything is stored. A response that fails verification is an
// error (the subject stays "timestamp pending" and is retried), never a stored token.
//
// DARK by two switches: SIGN_TSA_URL unset ⇒ no adapter; and the launch-availability key
// `sign.trusted_timestamp` must be AVAILABLE (it is NOT_AVAILABLE until the PO flips it,
// R-8). The TSA itself is a PO contract (§5 D-3): a public RFC 3161 TSA for build/test,
// a commercial TSA (DigiCert or GlobalSign) before GA.

export const SIGN_TSA_URL_ENV = 'SIGN_TSA_URL';
export const SIGN_TSA_TIMEOUT_MS_ENV = 'SIGN_TSA_TIMEOUT_MS';
export const SIGN_TRUSTED_TIMESTAMP_FEATURE = 'sign.trusted_timestamp';

const DEFAULT_TIMEOUT_MS = 5_000;
// A TimeStampResp with a certificate chain is a few KiB; anything far larger is refused.
const MAX_RESPONSE_BYTES = 256 * 1024;

export class TsaConfigError extends Error {
  constructor(message: string) {
    super(`SIGN_TSA configuration refused: ${message}`);
    this.name = 'TsaConfigError';
  }
}

export interface Rfc3161HttpTsaOptions {
  timeoutMs?: number;
  maxClockSkewMs?: number;
  fetchImpl?: typeof fetch;
  nonce?: () => Buffer;
  now?: () => Date;
}

export class Rfc3161HttpTsaAdapter implements TrustedTimestampPort {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly nonce: () => Buffer;
  private readonly now: () => Date;

  constructor(
    readonly tsa_url: string,
    private readonly options: Rfc3161HttpTsaOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nonce = options.nonce ?? (() => randomBytes(8));
    this.now = options.now ?? (() => new Date());
  }

  async timestamp(sha256Hex: string): Promise<TrustedTimestampToken> {
    if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new Error('a SHA-256 digest is 64 lowercase hex characters');
    const sha256 = Buffer.from(sha256Hex, 'hex');
    const nonce = this.nonce();
    const body = buildTimeStampRequest({ sha256, nonce, certReq: true });
    const res = await this.fetchImpl(this.tsa_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query', Accept: 'application/timestamp-reply' },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`TSA responded HTTP ${res.status}`);
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_RESPONSE_BYTES) throw new Error('TSA response is too large');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('TSA response is too large');
    const verified = verifyTimeStampResponse(bytes, {
      sha256,
      nonce,
      now: this.now(),
      ...(this.options.maxClockSkewMs !== undefined ? { maxClockSkewMs: this.options.maxClockSkewMs } : {}),
    });
    return {
      token_der: verified.token_der,
      gen_time: verified.gen_time,
      serial_number: verified.serial_number,
      policy_oid: verified.policy_oid,
      hash_algorithm: verified.hash_algorithm,
      message_imprint_sha256: verified.message_imprint_sha256,
      tsa_name: verified.tsa_name,
      tsa_certificate_sha256: verified.tsa_certificate_sha256,
    };
  }
}

function parseTsaUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TsaConfigError(`${SIGN_TSA_URL_ENV} is not a valid URL`);
  }
  // RFC 3161 tokens are signed, so plain HTTP is allowed (several commercial TSAs serve
  // only HTTP); any other scheme, or credentials in the URL, are refused.
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TsaConfigError(`${SIGN_TSA_URL_ENV} must be an http(s) URL`);
  if (url.username !== '' || url.password !== '') throw new TsaConfigError(`${SIGN_TSA_URL_ENV} must not carry credentials`);
  return url.toString();
}

/**
 * The composition-root binding for TRUSTED_TIMESTAMP_PORT. Returns null (feature off)
 * when SIGN_TSA_URL is unset, or when `sign.trusted_timestamp` is not AVAILABLE. An
 * invalid URL or timeout refuses boot rather than silently disabling the feature.
 */
export function trustedTimestampFromEnv(
  env: NodeJS.ProcessEnv,
  registry: Readonly<Record<string, FeatureAvailability>> = FEATURE_AVAILABILITY,
  options: Omit<Rfc3161HttpTsaOptions, 'timeoutMs'> = {},
): Rfc3161HttpTsaAdapter | null {
  const raw = (env[SIGN_TSA_URL_ENV] ?? '').trim();
  if (raw === '') return null;
  const url = parseTsaUrl(raw);
  const rawTimeout = (env[SIGN_TSA_TIMEOUT_MS_ENV] ?? '').trim();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== '') {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 60_000) {
      throw new TsaConfigError(`${SIGN_TSA_TIMEOUT_MS_ENV} must be an integer between 500 and 60000`);
    }
  }
  if (!isFeatureAvailable(SIGN_TRUSTED_TIMESTAMP_FEATURE, registry)) {
    new Logger('TrustedTimestamp').warn(`${SIGN_TSA_URL_ENV} is set but ${SIGN_TRUSTED_TIMESTAMP_FEATURE} is not available; trusted timestamps stay off`);
    return null;
  }
  return new Rfc3161HttpTsaAdapter(url, { ...options, timeoutMs });
}
