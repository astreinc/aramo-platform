// Feature-Parity Directive v1.0 §1.15 (AATL document seal), Amendment A1; PO direction
// 2026-11-01: the AATL vendor is not chosen, so there is ONE vendor-neutral remote
// hash-signing adapter (RemoteHashSigningProvider) and the vendor is picked by
// configuration (SIGN_SEAL_PROVIDER = a profile id below).
//
// A profile is data plus small request/response mappers. It covers what AATL cloud
// signing services share:
//   1. authenticate: mTLS client certificate and/or an API-key login or OAuth 2.0 client
//      credentials (bearer token);
//   2. obtain the seal certificate and its chain;
//   3. send a SHA-256 hash and get back a raw RSA PKCS#1 v1.5 signature, or a CMS whose
//      SignerInfo signs the hash directly (no signed attributes).
// A profile is ENABLED only where it is grounded in the vendor's public API reference;
// the others are documented TODO profiles, disabled: selecting one refuses to boot.

export type SealAuthMode = 'mtls' | 'api_key_login' | 'oauth_client_credentials';

export interface SealProfileConfig {
  endpoint: string; // SIGN_SEAL_ENDPOINT, no trailing slash
  credential_id: string | null; // SIGN_SEAL_CERT_CREDENTIAL_ID
  subject_dn: Record<string, unknown> | null; // SIGN_SEAL_CERT_SUBJECT_DN (JSON)
}

export interface SealHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  json?: unknown;
  form?: Record<string, string>;
}

/** The identity a profile returns: certificate + chain, and the handle used to sign. */
export interface SealProfileIdentity {
  certificate_der: Buffer;
  chain_der: Buffer[];
  /** Profile-specific signing handle (GlobalSign identity id; CSC credentialID). */
  handle: string;
}

export type SealHttp = (req: SealHttpRequest) => Promise<Record<string, unknown>>;

export interface SealProviderProfile {
  id: string;
  status: 'enabled' | 'todo';
  /** Public API reference the mapping is grounded in. */
  reference: string;
  /** Auth modes required by default (SIGN_SEAL_AUTH_TYPE may override). */
  auth: SealAuthMode[];
  /** API-key login: request and token extraction. */
  apiKeyLogin?: (cfg: SealProfileConfig, key: string, secret: string) => { req: SealHttpRequest; token: (res: Record<string, unknown>) => string };
  /** Default OAuth token URL when SIGN_SEAL_AUTH_TOKEN_URL is unset. */
  oauthTokenUrl?: (cfg: SealProfileConfig) => string;
  /** Obtain the seal identity (certificate + chain). */
  identity: (cfg: SealProfileConfig, http: SealHttp) => Promise<SealProfileIdentity>;
  /** Sign one SHA-256 digest; returns the raw signature or a CMS (see `response`). */
  signHash: (cfg: SealProfileConfig, http: SealHttp, identity: SealProfileIdentity, digest: Buffer) => Promise<Buffer>;
  response: 'raw' | 'cms';
  /** Seconds an identity may be reused before it is fetched again. */
  identity_ttl_seconds: number;
  /** Required SIGN_SEAL_CERT_* settings. */
  requires: Array<'credential_id' | 'subject_dn'>;
}

export const SHA256_OID = '2.16.840.1.101.3.4.2.1';
export const RSA_ENCRYPTION_OID = '1.2.840.113549.1.1.1';

export class SealProviderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealProviderResponseError';
  }
}

function str(res: Record<string, unknown>, key: string): string {
  const v = res[key];
  if (typeof v !== 'string' || v.length === 0) throw new SealProviderResponseError(`seal provider response is missing "${key}"`);
  return v;
}

/** DER certificates from one or more PEM blocks. */
export function pemToDer(pem: string): Buffer[] {
  const out: Buffer[] = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  for (let m = re.exec(pem); m !== null; m = re.exec(pem)) out.push(Buffer.from((m[1] ?? '').replace(/\s+/g, ''), 'base64'));
  return out;
}

const notGrounded = async (): Promise<never> => {
  throw new SealProviderResponseError('this seal provider profile is a TODO and is disabled');
};

export const SEAL_PROVIDER_PROFILES: Readonly<Record<string, SealProviderProfile>> = {
  // GlobalSign Digital Signing Service (DSS) API v2 — the D-3 build default.
  // Market reference: Zoho Sign's seal chains to GlobalSign (GlobalSign GCC R45 AATL CA
  // 2020 -> GlobalSign R45 AATL Root CA 2020).
  // Reference: GlobalSign "Digital Signing Service API" documentation
  //   POST /login {api_key, api_secret} -> {access_token}            (mTLS + bearer)
  //   POST /identity {subject_dn}       -> {id, signing_cert (PEM)}  (short-lived identity)
  //   GET  /certificate_path            -> {path (PEM)}              (issuing CA)
  //   GET  /identity/{id}/sign/{digest} -> {signature (hex)}         (digest = SHA-256 hex)
  'globalsign-dss': {
    id: 'globalsign-dss',
    status: 'enabled',
    reference: 'https://www.globalsign.com/en/resources/apis/api-documentation/digital-signing-service-api-documentation.html',
    auth: ['mtls', 'api_key_login'],
    apiKeyLogin: (cfg, key, secret) => ({
      req: { method: 'POST', url: `${cfg.endpoint}/login`, json: { api_key: key, api_secret: secret } },
      token: (res) => str(res, 'access_token'),
    }),
    identity: async (cfg, http) => {
      const created = await http({ method: 'POST', url: `${cfg.endpoint}/identity`, json: { subject_dn: cfg.subject_dn ?? {} } });
      const [certificate_der] = pemToDer(str(created, 'signing_cert'));
      if (certificate_der === undefined) throw new SealProviderResponseError('seal provider returned no signing certificate');
      const path = await http({ method: 'GET', url: `${cfg.endpoint}/certificate_path` });
      return { certificate_der, chain_der: pemToDer(str(path, 'path')), handle: str(created, 'id') };
    },
    signHash: async (cfg, http, identity, digest) => {
      const res = await http({ method: 'GET', url: `${cfg.endpoint}/identity/${encodeURIComponent(identity.handle)}/sign/${digest.toString('hex').toUpperCase()}` });
      return Buffer.from(str(res, 'signature'), 'hex');
    },
    response: 'raw',
    // DSS identities are short-lived; reuse one for a few minutes only.
    identity_ttl_seconds: 300,
    requires: ['subject_dn'],
  },

  // Cloud Signature Consortium API v2.0 (remote signing standard implemented by many
  // QTSPs/CAs). Reference: CSC "Architectures and protocols for remote signature
  // applications" v2.0.0.2
  //   POST oauth2/token (client_credentials)                       -> {access_token}
  //   POST csc/v2/credentials/info {credentialID, certificates: "chain"} -> {cert.certificates[] (base64 DER)}
  //   POST csc/v2/credentials/authorize {credentialID, numSignatures, hashes, hashAlgorithmOID} -> {SAD}
  //   POST csc/v2/signatures/signHash {credentialID, SAD, hashes, hashAlgorithmOID, signAlgo} -> {signatures[] (base64)}
  csc: {
    id: 'csc',
    status: 'enabled',
    reference: 'https://cloudsignatureconsortium.org/resources/download-api-specifications/ (CSC API v2.0)',
    auth: ['oauth_client_credentials'],
    oauthTokenUrl: (cfg) => `${cfg.endpoint}/oauth2/token`,
    identity: async (cfg, http) => {
      const credentialID = cfg.credential_id ?? '';
      const info = await http({ method: 'POST', url: `${cfg.endpoint}/csc/v2/credentials/info`, json: { credentialID, certificates: 'chain', certInfo: false } });
      const cert = info['cert'] as { certificates?: unknown } | undefined;
      const list = Array.isArray(cert?.certificates) ? (cert.certificates as unknown[]).filter((c): c is string => typeof c === 'string') : [];
      const [first, ...rest] = list.map((b64) => Buffer.from(b64, 'base64'));
      if (first === undefined) throw new SealProviderResponseError('seal provider returned no signing certificate');
      return { certificate_der: first, chain_der: rest, handle: credentialID };
    },
    signHash: async (cfg, http, identity, digest) => {
      const hashes = [digest.toString('base64')];
      const auth = await http({ method: 'POST', url: `${cfg.endpoint}/csc/v2/credentials/authorize`, json: { credentialID: identity.handle, numSignatures: 1, hashes, hashAlgorithmOID: SHA256_OID } });
      const res = await http({
        method: 'POST',
        url: `${cfg.endpoint}/csc/v2/signatures/signHash`,
        json: { credentialID: identity.handle, SAD: str(auth, 'SAD'), hashes, hashAlgorithmOID: SHA256_OID, signAlgo: RSA_ENCRYPTION_OID },
      });
      const sigs = res['signatures'];
      if (!Array.isArray(sigs) || typeof sigs[0] !== 'string') throw new SealProviderResponseError('seal provider response is missing "signatures"');
      return Buffer.from(sigs[0], 'base64');
    },
    response: 'raw',
    identity_ttl_seconds: 3600,
    requires: ['credential_id'],
  },

  // TODO (disabled): SSL.com eSigner exposes a CSC-style API (eSigner CSC API) with
  // per-signature OTP/TOTP authorization for automated seals. Enable once the account's
  // endpoint version, the TOTP/SAD flow for automated document seals and the OAuth
  // grant are confirmed against SSL.com's published reference.
  'ssl-com-esigner': {
    id: 'ssl-com-esigner',
    status: 'todo',
    reference: 'https://www.ssl.com/guide/esigner-csc-api/ (to confirm)',
    auth: ['oauth_client_credentials'],
    identity: notGrounded,
    signHash: notGrounded,
    response: 'raw',
    identity_ttl_seconds: 300,
    requires: ['credential_id'],
  },

  // TODO (disabled): DigiCert Document Trust Manager / DigiCert ONE remote signing.
  // Market reference: DocuSign's seal chains to DigiCert Trusted G4 AATL RSA4096 SHA384
  // 2022 CA1.
  // Enable once the endpoint paths, auth (mTLS client certificate and/or API key) and
  // response encoding are confirmed against DigiCert's published API reference; if the
  // account exposes the CSC API, select the `csc` profile instead.
  digicert: {
    id: 'digicert',
    status: 'todo',
    reference: 'https://docs.digicert.com/ (Document Trust Manager API, to confirm)',
    auth: ['mtls'],
    identity: notGrounded,
    signHash: notGrounded,
    response: 'raw',
    identity_ttl_seconds: 300,
    requires: [],
  },
};
