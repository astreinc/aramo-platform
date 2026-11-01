import { Logger } from '@nestjs/common';
import {
  DisabledQesSigningAdapter,
  QesProviderError,
  type QesBeginIdentityInput,
  type QesBeginSignatureInput,
  type QesCompleteIdentityInput,
  type QesCredential,
  type QesSignHashInput,
  type QesSignatureResult,
  type QesSigningPort,
} from '@aramo/sign';

// Feature-Parity §1.16 under Amendment A1 — a GENERIC Cloud Signature Consortium (CSC)
// API v2 remote-signing adapter. It names no QTSP and needs only configuration; while
// its environment is unset the composition root binds the disabled adapter instead. It
// is exercised only against stubs (no live QTSP is ever called by a test).
//
//   SIGN_QES_PROVIDER=csc
//   SIGN_QES_CSC_BASE_URL       CSC API base, e.g. https://qtsp.example/csc/v2
//   SIGN_QES_CSC_OAUTH_URL      OAuth 2.0 base, e.g. https://qtsp.example/oauth2
//   SIGN_QES_CSC_CLIENT_ID      Aramo's OAuth client id at the QTSP
//   SIGN_QES_CSC_CLIENT_SECRET  Aramo's OAuth client secret at the QTSP
//
// CSC v2 calls used: OAuth2 authorize (scope service, then scope credential bound to the
// hash), OAuth2 token (authorization_code), credentials/list (credentialInfo + chain),
// credentials/info (fallback), signatures/signHash. Access tokens live only for the one
// request that obtained them; nothing secret is logged.

export interface CscQesConfig {
  base_url: string;
  oauth_url: string;
  client_id: string;
  client_secret: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const TIMEOUT_MS = 15_000;

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

function derToPem(b64: string): string {
  const body = b64.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

function toPem(cert: string): string {
  return cert.includes('-----BEGIN CERTIFICATE-----') ? cert.trim() : derToPem(cert);
}

function base64url(b64: string): string {
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface CscCredentialInfo {
  credentialID?: unknown;
  key?: { algo?: unknown };
  cert?: { certificates?: unknown };
  SCAL?: unknown;
}

export class CscQesSigningAdapter implements QesSigningPort {
  readonly provider = 'csc';
  readonly configured = true;
  private readonly logger = new Logger('CscQesSigningAdapter');

  constructor(
    private readonly config: CscQesConfig,
    private readonly fetchFn: FetchLike = (url, init) => fetch(url, init),
  ) {}

  async beginIdentity(input: QesBeginIdentityInput): Promise<{ redirect_url: string }> {
    const q = new URLSearchParams({ response_type: 'code', client_id: this.config.client_id, redirect_uri: input.redirect_uri, scope: 'service', state: input.state });
    if (input.signer.email !== null) q.set('login_hint', input.signer.email);
    return { redirect_url: `${trimSlash(this.config.oauth_url)}/authorize?${q.toString()}` };
  }

  async completeIdentity(input: QesCompleteIdentityInput): Promise<QesCredential> {
    const token = await this.token(input.authorization_code, input.redirect_uri);
    const listed = (await this.call('credentials/list', token, { credentialInfo: true, certificates: 'chain', certInfo: false, authInfo: false, onlyValid: true })) as { credentialIDs?: unknown; credentialInfos?: unknown };
    const ids = Array.isArray(listed.credentialIDs) ? listed.credentialIDs.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
    const first = ids[0];
    if (first === undefined) throw new QesProviderError('qtsp_no_credential');
    let info = Array.isArray(listed.credentialInfos) ? (listed.credentialInfos as CscCredentialInfo[]).find((c) => c?.credentialID === first) : undefined;
    if (info === undefined || !Array.isArray(info.cert?.certificates)) {
      info = (await this.call('credentials/info', token, { credentialID: first, certificates: 'chain', certInfo: false, authInfo: false })) as CscCredentialInfo;
    }
    const certs = Array.isArray(info.cert?.certificates) ? (info.cert.certificates as unknown[]).filter((c): c is string => typeof c === 'string' && c.length > 0) : [];
    if (certs.length === 0) throw new QesProviderError('qtsp_no_certificate');
    const algos = Array.isArray(info.key?.algo) ? (info.key.algo as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    return {
      credential_id: first,
      certificate_chain_pem: certs.map(toPem),
      signature_algorithm_oids: algos,
      authorization_level: typeof info.SCAL === 'string' ? info.SCAL : null,
    };
  }

  async beginSignature(input: QesBeginSignatureInput): Promise<{ redirect_url: string }> {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.client_id,
      redirect_uri: input.redirect_uri,
      scope: 'credential',
      credentialID: input.credential_id,
      numSignatures: '1',
      hashes: base64url(input.hash_b64),
      hashAlgorithmOID: input.hash_algorithm_oid,
      state: input.state,
    });
    return { redirect_url: `${trimSlash(this.config.oauth_url)}/authorize?${q.toString()}` };
  }

  async signHash(input: QesSignHashInput): Promise<QesSignatureResult> {
    const token = await this.token(input.authorization_code, input.redirect_uri);
    const out = (await this.call('signatures/signHash', token, {
      credentialID: input.credential_id,
      hashes: [input.hash_b64],
      hashAlgorithmOID: input.hash_algorithm_oid,
      signAlgo: input.signature_algorithm_oid,
      operationMode: 'S',
    })) as { signatures?: unknown; responseID?: unknown };
    const sig = Array.isArray(out.signatures) ? out.signatures[0] : undefined;
    if (typeof sig !== 'string' || sig.length === 0) throw new QesProviderError('qtsp_no_signature');
    return { signature_b64: sig, qtsp_reference: typeof out.responseID === 'string' ? out.responseID : null };
  }

  private async token(code: string, redirect_uri: string): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.config.client_id, client_secret: this.config.client_secret, redirect_uri });
    const res = await this.send(`${trimSlash(this.config.oauth_url)}/token`, { 'Content-Type': 'application/x-www-form-urlencoded' }, body.toString(), 'oauth2/token');
    const token = (res as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || token.length === 0) throw new QesProviderError('qtsp_token_refused');
    return token;
  }

  private call(path: string, token: string, body: Record<string, unknown>): Promise<unknown> {
    return this.send(`${trimSlash(this.config.base_url)}/${path}`, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, JSON.stringify(body), path);
  }

  private async send(url: string, headers: Record<string, string>, body: string, op: string): Promise<unknown> {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchFn(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      this.logger.warn(`QTSP ${op} unreachable`);
      throw new QesProviderError('qtsp_unreachable');
    }
    if (!res.ok) {
      // Status only: CSC error bodies may echo request values.
      this.logger.warn(`QTSP ${op} refused (${res.status})`);
      throw new QesProviderError(`qtsp_http_${res.status}`);
    }
    try {
      return await res.json();
    } catch {
      throw new QesProviderError('qtsp_bad_response');
    }
  }
}

function httpsUrl(v: string | undefined): string | null {
  const t = v?.trim();
  if (t === undefined || t === '') return null;
  try {
    return new URL(t).protocol === 'https:' ? t : null;
  } catch {
    return null;
  }
}

/**
 * SIGN_QES_PROVIDER=csc with all four SIGN_QES_CSC_* values (https URLs) → the CSC
 * adapter; anything else (the default: unset) → disabled.
 */
export function qesSigningAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): QesSigningPort {
  if (env['SIGN_QES_PROVIDER']?.trim().toLowerCase() !== 'csc') return new DisabledQesSigningAdapter();
  const base_url = httpsUrl(env['SIGN_QES_CSC_BASE_URL']);
  const oauth_url = httpsUrl(env['SIGN_QES_CSC_OAUTH_URL']);
  const client_id = env['SIGN_QES_CSC_CLIENT_ID']?.trim() ?? '';
  const client_secret = env['SIGN_QES_CSC_CLIENT_SECRET']?.trim() ?? '';
  if (base_url === null || oauth_url === null || client_id === '' || client_secret === '') {
    new Logger('QesSigning').warn('SIGN_QES_PROVIDER=csc is incomplete (https base/OAuth URLs, client id and secret are required); QES stays disabled');
    return new DisabledQesSigningAdapter();
  }
  return new CscQesSigningAdapter({ base_url, oauth_url, client_id, client_secret });
}
