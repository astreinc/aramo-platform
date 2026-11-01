import { request as httpsRequest, Agent } from 'node:https';

import { Logger } from '@nestjs/common';
import { isFeatureAvailable, type FeatureAvailability } from '@aramo/subscription';
import { signatureFromVendorCms, type DocumentSealIdentity, type DocumentSealSigningProvider } from '@aramo/sign';

import {
  SEAL_PROVIDER_PROFILES,
  SealProviderResponseError,
  pemToDer,
  type SealAuthMode,
  type SealHttp,
  type SealHttpRequest,
  type SealProfileConfig,
  type SealProfileIdentity,
  type SealProviderProfile,
} from './seal-provider-profiles.js';

// Feature-Parity Directive v1.0 §1.15, Amendment A1, PO direction 2026-11-01 — the ONE
// vendor-neutral remote hash-signing adapter. The vendor is a configuration profile
// (seal-provider-profiles.ts); this class only runs a profile: authenticate, fetch and
// cache the identity, sign a hash, and normalise the result to a raw signature. The
// PAdES engine (libs/sign) verifies every returned signature against the certificate
// before it is embedded, so a mis-mapped vendor fails closed.
//
// Env (unset SIGN_SEAL_PROVIDER = off; `sign.document_seal` must also be AVAILABLE):
//   SIGN_SEAL_PROVIDER              profile id (globalsign-dss | csc | ssl-com-esigner | digicert)
//   SIGN_SEAL_ENDPOINT              https base URL of the vendor API
//   SIGN_SEAL_AUTH_TYPE             optional override, comma list of mtls,api_key_login,oauth_client_credentials
//   SIGN_SEAL_AUTH_API_KEY / SIGN_SEAL_AUTH_API_SECRET       (api_key_login)
//   SIGN_SEAL_AUTH_CLIENT_ID / SIGN_SEAL_AUTH_CLIENT_SECRET  (oauth_client_credentials)
//   SIGN_SEAL_AUTH_TOKEN_URL        optional OAuth token URL (profile default otherwise)
//   SIGN_SEAL_AUTH_MTLS_CERT / SIGN_SEAL_AUTH_MTLS_KEY       (mtls; PEM, base64-encoded)
//   SIGN_SEAL_CERT_CREDENTIAL_ID    the vendor's credential / key id (CSC)
//   SIGN_SEAL_CERT_SUBJECT_DN       JSON subject DN for identity issuance (GlobalSign DSS)
//   SIGN_SEAL_CERT_CHAIN            optional extra intermediate PEMs (base64) appended to the chain

export class DocumentSealConfigError extends Error {
  constructor(message: string) {
    super(`document seal configuration: ${message}`);
    this.name = 'DocumentSealConfigError';
  }
}

export interface RemoteHashSigningSettings {
  profile: SealProviderProfile;
  config: SealProfileConfig;
  auth: SealAuthMode[];
  api_key?: string;
  api_secret?: string;
  client_id?: string;
  client_secret?: string;
  token_url?: string;
  mtls_cert_pem?: string;
  mtls_key_pem?: string;
  extra_chain_der: Buffer[];
}

export interface SealTransportResponse {
  status: number;
  body: string;
}
export type SealTransport = (req: SealHttpRequest & { headers: Record<string, string> }) => Promise<SealTransportResponse>;

const REQUEST_TIMEOUT_MS = 15_000;

const b64 = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key];
  if (v === undefined || v.trim() === '') return undefined;
  return Buffer.from(v.trim(), 'base64').toString('utf8');
};
const opt = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const v = env[key]?.trim();
  return v === undefined || v === '' ? undefined : v;
};

/**
 * Parse SIGN_SEAL_* into settings. Returns null when SIGN_SEAL_PROVIDER is unset (off).
 * An invalid setting throws DocumentSealConfigError (refuse to boot, never a silent off).
 */
export function remoteHashSigningSettingsFromEnv(env: NodeJS.ProcessEnv): RemoteHashSigningSettings | null {
  const id = opt(env, 'SIGN_SEAL_PROVIDER');
  if (id === undefined) return null;
  const profile = SEAL_PROVIDER_PROFILES[id];
  if (profile === undefined) throw new DocumentSealConfigError(`unknown SIGN_SEAL_PROVIDER "${id}" (known: ${Object.keys(SEAL_PROVIDER_PROFILES).join(', ')})`);
  if (profile.status !== 'enabled') throw new DocumentSealConfigError(`SIGN_SEAL_PROVIDER "${id}" is a TODO profile and is disabled`);
  const endpoint = opt(env, 'SIGN_SEAL_ENDPOINT');
  if (endpoint === undefined || !/^https:\/\/[^\s]+$/.test(endpoint)) throw new DocumentSealConfigError('SIGN_SEAL_ENDPOINT must be an https URL');

  const authOverride = opt(env, 'SIGN_SEAL_AUTH_TYPE');
  const auth = (authOverride === undefined ? profile.auth : authOverride.split(',').map((s) => s.trim())) as SealAuthMode[];
  for (const a of auth) if (!['mtls', 'api_key_login', 'oauth_client_credentials'].includes(a)) throw new DocumentSealConfigError(`unknown SIGN_SEAL_AUTH_TYPE "${a}"`);
  if (auth.length === 0) throw new DocumentSealConfigError('at least one auth mode is required');

  const s: RemoteHashSigningSettings = {
    profile,
    config: { endpoint: endpoint.replace(/\/+$/, ''), credential_id: opt(env, 'SIGN_SEAL_CERT_CREDENTIAL_ID') ?? null, subject_dn: null },
    auth,
    extra_chain_der: [],
  };
  const subject = opt(env, 'SIGN_SEAL_CERT_SUBJECT_DN');
  if (subject !== undefined) {
    try {
      const parsed = JSON.parse(subject) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      s.config.subject_dn = parsed as Record<string, unknown>;
    } catch {
      throw new DocumentSealConfigError('SIGN_SEAL_CERT_SUBJECT_DN must be a JSON object');
    }
  }
  for (const r of profile.requires) {
    if (r === 'credential_id' && s.config.credential_id === null) throw new DocumentSealConfigError(`profile ${id} requires SIGN_SEAL_CERT_CREDENTIAL_ID`);
    if (r === 'subject_dn' && s.config.subject_dn === null) throw new DocumentSealConfigError(`profile ${id} requires SIGN_SEAL_CERT_SUBJECT_DN`);
  }
  if (auth.includes('mtls')) {
    s.mtls_cert_pem = b64(env, 'SIGN_SEAL_AUTH_MTLS_CERT');
    s.mtls_key_pem = b64(env, 'SIGN_SEAL_AUTH_MTLS_KEY');
    if (s.mtls_cert_pem === undefined || s.mtls_key_pem === undefined) throw new DocumentSealConfigError('mtls requires SIGN_SEAL_AUTH_MTLS_CERT and SIGN_SEAL_AUTH_MTLS_KEY');
  }
  if (auth.includes('api_key_login')) {
    s.api_key = opt(env, 'SIGN_SEAL_AUTH_API_KEY');
    s.api_secret = opt(env, 'SIGN_SEAL_AUTH_API_SECRET');
    if (s.api_key === undefined || s.api_secret === undefined) throw new DocumentSealConfigError('api_key_login requires SIGN_SEAL_AUTH_API_KEY and SIGN_SEAL_AUTH_API_SECRET');
    if (profile.apiKeyLogin === undefined) throw new DocumentSealConfigError(`profile ${id} has no api_key_login mapping`);
  }
  if (auth.includes('oauth_client_credentials')) {
    s.client_id = opt(env, 'SIGN_SEAL_AUTH_CLIENT_ID');
    s.client_secret = opt(env, 'SIGN_SEAL_AUTH_CLIENT_SECRET');
    s.token_url = opt(env, 'SIGN_SEAL_AUTH_TOKEN_URL') ?? profile.oauthTokenUrl?.(s.config);
    if (s.client_id === undefined || s.client_secret === undefined) throw new DocumentSealConfigError('oauth_client_credentials requires SIGN_SEAL_AUTH_CLIENT_ID and SIGN_SEAL_AUTH_CLIENT_SECRET');
    if (s.token_url === undefined || !s.token_url.startsWith('https://')) throw new DocumentSealConfigError('oauth_client_credentials requires an https SIGN_SEAL_AUTH_TOKEN_URL');
  }
  const chain = b64(env, 'SIGN_SEAL_CERT_CHAIN');
  if (chain !== undefined) {
    s.extra_chain_der = pemToDer(chain);
    if (s.extra_chain_der.length === 0) throw new DocumentSealConfigError('SIGN_SEAL_CERT_CHAIN holds no PEM certificate');
  }
  return s;
}

/** The node:https transport (mTLS client certificate when configured). */
export function httpsSealTransport(settings: Pick<RemoteHashSigningSettings, 'mtls_cert_pem' | 'mtls_key_pem'>): SealTransport {
  const agent = new Agent({
    keepAlive: true,
    ...(settings.mtls_cert_pem !== undefined ? { cert: settings.mtls_cert_pem, key: settings.mtls_key_pem } : {}),
  });
  return (req) =>
    new Promise((resolve, reject) => {
      const body = req.json !== undefined ? JSON.stringify(req.json) : req.form !== undefined ? new URLSearchParams(req.form).toString() : undefined;
      const r = httpsRequest(req.url, { method: req.method, agent, headers: { ...req.headers, ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) }, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      r.on('timeout', () => r.destroy(Object.assign(new Error('seal provider request timed out'), { name: 'SealProviderTimeout' })));
      r.on('error', reject);
      if (body !== undefined) r.write(body);
      r.end();
    });
}

export class SealProviderHttpError extends Error {
  constructor(public readonly status: number, path: string) {
    // Status and path only: never the response body (it may echo credentials).
    super(`seal provider HTTP ${status} on ${path}`);
    this.name = 'SealProviderHttpError';
  }
}

interface CachedIdentity {
  identity: DocumentSealIdentity & { handle: string };
  expires_at: number;
}

export class RemoteHashSigningProvider implements DocumentSealSigningProvider {
  readonly provider_id: string;
  private token: { value: string; expires_at: number } | null = null;
  private cached: CachedIdentity | null = null;

  constructor(
    private readonly settings: RemoteHashSigningSettings,
    private readonly transport: SealTransport = httpsSealTransport(settings),
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.provider_id = settings.profile.id;
  }

  private async bearer(): Promise<string | null> {
    const s = this.settings;
    if (this.token !== null && this.token.expires_at > this.clock()) return this.token.value;
    let value: string | null = null;
    let ttl = 1500;
    if (s.auth.includes('api_key_login') && s.profile.apiKeyLogin !== undefined) {
      const login = s.profile.apiKeyLogin(s.config, s.api_key ?? '', s.api_secret ?? '');
      value = login.token(await this.raw(login.req, null));
    } else if (s.auth.includes('oauth_client_credentials')) {
      const res = await this.raw({ method: 'POST', url: s.token_url ?? '', form: { grant_type: 'client_credentials', client_id: s.client_id ?? '', client_secret: s.client_secret ?? '' } }, null);
      if (typeof res['access_token'] !== 'string') throw new SealProviderResponseError('seal provider token response is missing "access_token"');
      value = res['access_token'];
      if (typeof res['expires_in'] === 'number') ttl = Math.max(30, res['expires_in'] - 30);
    }
    if (value === null) return null;
    this.token = { value, expires_at: this.clock() + ttl * 1000 };
    return value;
  }

  private async raw(req: SealHttpRequest, bearer: string | null): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (req.json !== undefined) headers['content-type'] = 'application/json;charset=utf-8';
    if (req.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (bearer !== null) headers['authorization'] = `Bearer ${bearer}`;
    const res = await this.transport({ ...req, headers });
    if (res.status < 200 || res.status >= 300) throw new SealProviderHttpError(res.status, new URL(req.url).pathname);
    try {
      const parsed = JSON.parse(res.body) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return parsed as Record<string, unknown>;
    } catch {
      throw new SealProviderResponseError('seal provider returned a non-JSON response');
    }
  }

  private readonly http: SealHttp = async (req) => this.raw(req, await this.bearer());

  async identity(): Promise<DocumentSealIdentity> {
    if (this.cached !== null && this.cached.expires_at > this.clock()) return this.cached.identity;
    const id: SealProfileIdentity = await this.settings.profile.identity(this.settings.config, this.http);
    const identity = { certificate_der: id.certificate_der, chain_der: [...id.chain_der, ...this.settings.extra_chain_der], handle: id.handle };
    this.cached = { identity, expires_at: this.clock() + this.settings.profile.identity_ttl_seconds * 1000 };
    return identity;
  }

  async signDigest(identity: DocumentSealIdentity, sha256Digest: Buffer): Promise<Buffer> {
    if (sha256Digest.length !== 32) throw new SealProviderResponseError('a SHA-256 digest is 32 bytes');
    const handle = (identity as DocumentSealIdentity & { handle?: string }).handle;
    if (handle === undefined) throw new SealProviderResponseError('identity was not issued by this provider');
    const out = await this.settings.profile.signHash(this.settings.config, this.http, { ...identity, handle }, sha256Digest);
    return this.settings.profile.response === 'cms' ? signatureFromVendorCms(out) : out;
  }
}

/**
 * The composition-root factory: a provider only when SIGN_SEAL_PROVIDER is set AND the
 * `sign.document_seal` feature is AVAILABLE. Otherwise null (dark). A set provider with
 * the feature NOT_AVAILABLE logs and stays off (R-8: never on before the PO flip).
 */
export function documentSealProviderFromEnv(
  env: NodeJS.ProcessEnv,
  registry?: Readonly<Record<string, FeatureAvailability>>,
): RemoteHashSigningProvider | null {
  const settings = remoteHashSigningSettingsFromEnv(env);
  if (settings === null) return null;
  if (!isFeatureAvailable('sign.document_seal', registry)) {
    new Logger('DocumentSeal').warn('SIGN_SEAL_PROVIDER is set but sign.document_seal is NOT_AVAILABLE; the document seal stays off');
    return null;
  }
  return new RemoteHashSigningProvider(settings);
}
