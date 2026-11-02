import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, type AgentOptions as HttpsAgentOptions, request as httpsRequest } from 'node:https';

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
//
// Optional TSA authentication (Remaining-Work Directive §3 B4; unset = an unauthenticated POST,
// the behaviour before it):
//   SIGN_TSA_USERNAME / SIGN_TSA_PASSWORD        HTTP basic credentials (both or neither;
//                                                https only — never sent over plain http)
//   SIGN_TSA_CLIENT_CERT / SIGN_TSA_CLIENT_KEY   a TLS client certificate and its private key,
//                                                PEM, base64-encoded (both or neither; https only)
// Either may be used alone or both together. A partial or invalid setting refuses boot.

export const SIGN_TSA_URL_ENV = 'SIGN_TSA_URL';
export const SIGN_TSA_TIMEOUT_MS_ENV = 'SIGN_TSA_TIMEOUT_MS';
export const SIGN_TSA_USERNAME_ENV = 'SIGN_TSA_USERNAME';
export const SIGN_TSA_PASSWORD_ENV = 'SIGN_TSA_PASSWORD';
export const SIGN_TSA_CLIENT_CERT_ENV = 'SIGN_TSA_CLIENT_CERT';
export const SIGN_TSA_CLIENT_KEY_ENV = 'SIGN_TSA_CLIENT_KEY';
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

export interface TsaBasicCredentials {
  username: string;
  password: string;
}

export interface TsaClientCertificate {
  cert_pem: string;
  key_pem: string;
}

export interface Rfc3161HttpTsaOptions {
  timeoutMs?: number;
  maxClockSkewMs?: number;
  fetchImpl?: typeof fetch;
  nonce?: () => Buffer;
  now?: () => Date;
  /** HTTP basic credentials sent as the Authorization header. */
  basicAuth?: TsaBasicCredentials;
  /** A TLS client certificate; the requests then go through node:https with it (not fetchImpl). */
  clientCertificate?: TsaClientCertificate;
}

/**
 * A fetch-compatible transport over node:http(s) with an https.Agent carrying the TLS client
 * certificate (global fetch cannot present one without an extra dependency). Only what the
 * adapter uses: POST with a byte body, status, headers.get, arrayBuffer; the abort signal ends
 * the request. The response body is capped (the adapter refuses larger replies anyway).
 */
export function clientCertificateFetch(
  client: TsaClientCertificate,
  maxBytes = 256 * 1024,
  // Tests only (a local TLS server with a self-signed certificate).
  agentOptions: HttpsAgentOptions = {},
): typeof fetch {
  const agent = new HttpsAgent({ ...agentOptions, cert: client.cert_pem, key: client.key_pem, keepAlive: true });
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => {
        headers[k] = v;
      });
      const body = init?.body instanceof Uint8Array ? Buffer.from(init.body) : undefined;
      if (body !== undefined) headers['content-length'] = String(body.length);
      const opts = { method: init?.method ?? 'GET', headers, ...(init?.signal ? { signal: init.signal } : {}) };
      const onResponse = (res: IncomingMessage): void => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy(new Error('TSA response is too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          const out = new Headers();
          for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') out.set(k, v);
          const status = res.statusCode ?? 0;
          resolve(new Response(status === 204 || status === 304 ? null : new Uint8Array(Buffer.concat(chunks)), { status: status < 200 || status > 599 ? 502 : status, headers: out }));
        });
      };
      const req =
        url.protocol === 'https:'
          ? httpsRequest(url, { ...opts, agent }, onResponse)
          : httpRequest(url, opts, onResponse);
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  return impl as typeof fetch;
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
    this.fetchImpl = options.fetchImpl ?? (options.clientCertificate !== undefined ? clientCertificateFetch(options.clientCertificate, MAX_RESPONSE_BYTES) : fetch);
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
      headers: {
        'Content-Type': 'application/timestamp-query',
        Accept: 'application/timestamp-reply',
        ...(this.options.basicAuth !== undefined
          ? { Authorization: `Basic ${Buffer.from(`${this.options.basicAuth.username}:${this.options.basicAuth.password}`, 'utf8').toString('base64')}` }
          : {}),
      },
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

const setting = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

/** SIGN_TSA_USERNAME / _PASSWORD and SIGN_TSA_CLIENT_CERT / _KEY → adapter options (none set ⇒ {}). */
export function tsaAuthFromEnv(env: NodeJS.ProcessEnv, url: string): Pick<Rfc3161HttpTsaOptions, 'basicAuth' | 'clientCertificate'> {
  const out: Pick<Rfc3161HttpTsaOptions, 'basicAuth' | 'clientCertificate'> = {};
  const https = new URL(url).protocol === 'https:';
  const username = setting(env, SIGN_TSA_USERNAME_ENV);
  const password = env[SIGN_TSA_PASSWORD_ENV] !== undefined && env[SIGN_TSA_PASSWORD_ENV] !== '' ? env[SIGN_TSA_PASSWORD_ENV] : undefined;
  if ((username === undefined) !== (password === undefined)) throw new TsaConfigError(`${SIGN_TSA_USERNAME_ENV} and ${SIGN_TSA_PASSWORD_ENV} are set together or not at all`);
  if (username !== undefined && password !== undefined) {
    if (username.includes(':')) throw new TsaConfigError(`${SIGN_TSA_USERNAME_ENV} must not contain ':' (HTTP basic)`);
    if (!https) throw new TsaConfigError(`credentials are sent only over https; ${SIGN_TSA_URL_ENV} is http`);
    out.basicAuth = { username, password };
  }
  const certB64 = setting(env, SIGN_TSA_CLIENT_CERT_ENV);
  const keyB64 = setting(env, SIGN_TSA_CLIENT_KEY_ENV);
  if ((certB64 === undefined) !== (keyB64 === undefined)) throw new TsaConfigError(`${SIGN_TSA_CLIENT_CERT_ENV} and ${SIGN_TSA_CLIENT_KEY_ENV} are set together or not at all`);
  if (certB64 !== undefined && keyB64 !== undefined) {
    if (!https) throw new TsaConfigError(`a client certificate needs an https ${SIGN_TSA_URL_ENV}`);
    const cert_pem = Buffer.from(certB64, 'base64').toString('utf8');
    const key_pem = Buffer.from(keyB64, 'base64').toString('utf8');
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(cert_pem);
    } catch {
      throw new TsaConfigError(`${SIGN_TSA_CLIENT_CERT_ENV} is not a base64-encoded PEM certificate`);
    }
    let key;
    try {
      key = createPrivateKey(key_pem);
    } catch {
      throw new TsaConfigError(`${SIGN_TSA_CLIENT_KEY_ENV} is not a base64-encoded PEM private key`);
    }
    if (!cert.checkPrivateKey(key)) throw new TsaConfigError(`${SIGN_TSA_CLIENT_KEY_ENV} does not match ${SIGN_TSA_CLIENT_CERT_ENV}`);
    out.clientCertificate = { cert_pem, key_pem };
  }
  return out;
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
  const auth = tsaAuthFromEnv(env, url);
  if (!isFeatureAvailable(SIGN_TRUSTED_TIMESTAMP_FEATURE, registry)) {
    new Logger('TrustedTimestamp').warn(`${SIGN_TSA_URL_ENV} is set but ${SIGN_TRUSTED_TIMESTAMP_FEATURE} is not available; trusted timestamps stay off`);
    return null;
  }
  return new Rfc3161HttpTsaAdapter(url, { ...auth, ...options, timeoutMs });
}
