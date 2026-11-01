import { constants, createHash, privateEncrypt } from 'node:crypto';

import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';
import { sealPdf } from '@aramo/sign';

import {
  DocumentSealConfigError,
  RemoteHashSigningProvider,
  SealProviderHttpError,
  documentSealProviderFromEnv,
  remoteHashSigningSettingsFromEnv,
  type SealTransport,
} from '../app/document-seal/remote-hash-signing.provider.js';
import { SEAL_PROVIDER_PROFILES } from '../app/document-seal/seal-provider-profiles.js';
// eslint-disable-next-line @nx/enforce-module-boundaries -- TEST-only seal identity fixture shared with libs/sign specs
import { createSelfSignedSealIdentity, verifySealedPdf } from '../../../../libs/sign/src/tests/fixtures/self-signed-seal-provider.js';

// Feature-Parity Directive v1.0 §1.15, PO direction 2026-11-01 — the ONE vendor-neutral
// remote hash-signing adapter, driven by SIGN_SEAL_PROVIDER profiles. A fake vendor
// (in-process transport, TEST key) answers each profile's documented requests; no
// live vendor is called.

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const DIGEST_INFO_SHA256 = Buffer.from('3031300d060960864801650304020105000420', 'hex');

const test = createSelfSignedSealIdentity('Aramo TEST Seal (fake vendor)');
const rawSign = (digest: Buffer): Buffer =>
  privateEncrypt({ key: test.privateKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([DIGEST_INFO_SHA256, digest]));

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
}

function fakeVendor(handler: (req: Seen) => { status?: number; body: unknown }): { transport: SealTransport; seen: Seen[] } {
  const seen: Seen[] = [];
  const transport: SealTransport = async (req) => {
    const s: Seen = { method: req.method, path: new URL(req.url).pathname, headers: req.headers, ...(req.json !== undefined ? { json: req.json } : {}), ...(req.form !== undefined ? { form: req.form } : {}) };
    seen.push(s);
    const r = handler(s);
    return { status: r.status ?? 200, body: JSON.stringify(r.body) };
  };
  return { transport, seen };
}

const MTLS = { SIGN_SEAL_AUTH_MTLS_CERT: b64('-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n'), SIGN_SEAL_AUTH_MTLS_KEY: b64('-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n') };
const GS_ENV = {
  SIGN_SEAL_PROVIDER: 'globalsign-dss',
  SIGN_SEAL_ENDPOINT: 'https://emea.api.dss.globalsign.com:8443/v2/',
  SIGN_SEAL_AUTH_API_KEY: 'k',
  SIGN_SEAL_AUTH_API_SECRET: 's',
  SIGN_SEAL_CERT_SUBJECT_DN: JSON.stringify({ common_name: 'Aramo Sign', organization: 'Aramo' }),
  ...MTLS,
};
const CSC_ENV = {
  SIGN_SEAL_PROVIDER: 'csc',
  SIGN_SEAL_ENDPOINT: 'https://csc.example.test',
  SIGN_SEAL_AUTH_CLIENT_ID: 'client',
  SIGN_SEAL_AUTH_CLIENT_SECRET: 'secret',
  SIGN_SEAL_CERT_CREDENTIAL_ID: 'cred-1',
};

async function executedPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([600, 800]);
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

describe('§1.15 remote hash-signing adapter — configuration', () => {
  it('unset SIGN_SEAL_PROVIDER = off (null)', () => {
    expect(remoteHashSigningSettingsFromEnv({})).toBeNull();
    expect(documentSealProviderFromEnv({})).toBeNull();
  });

  it('stays off while sign.document_seal is NOT_AVAILABLE, even when fully configured', () => {
    expect(FEATURE_AVAILABILITY['sign.document_seal']).toBe('NOT_AVAILABLE');
    expect(documentSealProviderFromEnv(GS_ENV)).toBeNull();
    expect(documentSealProviderFromEnv(GS_ENV, { 'sign.document_seal': 'AVAILABLE' })).toBeInstanceOf(RemoteHashSigningProvider);
  });

  it('refuses to boot on an unknown or TODO profile, or incomplete settings', () => {
    expect(() => remoteHashSigningSettingsFromEnv({ SIGN_SEAL_PROVIDER: 'acme' })).toThrow(DocumentSealConfigError);
    for (const todo of ['ssl-com-esigner', 'digicert']) {
      expect(SEAL_PROVIDER_PROFILES[todo]?.status).toBe('todo');
      expect(() => remoteHashSigningSettingsFromEnv({ SIGN_SEAL_PROVIDER: todo, SIGN_SEAL_ENDPOINT: 'https://x.test' })).toThrow(/TODO profile/);
    }
    expect(() => remoteHashSigningSettingsFromEnv({ ...GS_ENV, SIGN_SEAL_ENDPOINT: 'http://insecure.test' })).toThrow(/https/);
    expect(() => remoteHashSigningSettingsFromEnv({ ...GS_ENV, SIGN_SEAL_AUTH_MTLS_KEY: '' })).toThrow(/mtls/);
    expect(() => remoteHashSigningSettingsFromEnv({ ...GS_ENV, SIGN_SEAL_AUTH_API_SECRET: '' })).toThrow(/api_key_login/);
    expect(() => remoteHashSigningSettingsFromEnv({ ...GS_ENV, SIGN_SEAL_CERT_SUBJECT_DN: 'not json' })).toThrow(/JSON/);
    expect(() => remoteHashSigningSettingsFromEnv({ ...CSC_ENV, SIGN_SEAL_CERT_CREDENTIAL_ID: '' })).toThrow(/CREDENTIAL_ID/);
    expect(() => remoteHashSigningSettingsFromEnv({ ...CSC_ENV, SIGN_SEAL_AUTH_TYPE: 'magic' })).toThrow(/SIGN_SEAL_AUTH_TYPE/);
  });

  it('parses a profile: auth modes, endpoint normalised, OAuth token URL default', () => {
    const gs = remoteHashSigningSettingsFromEnv(GS_ENV);
    expect(gs?.auth).toEqual(['mtls', 'api_key_login']);
    expect(gs?.config.endpoint).toBe('https://emea.api.dss.globalsign.com:8443/v2');
    const csc = remoteHashSigningSettingsFromEnv(CSC_ENV);
    expect(csc?.token_url).toBe('https://csc.example.test/oauth2/token');
    expect(remoteHashSigningSettingsFromEnv({ ...CSC_ENV, SIGN_SEAL_AUTH_TYPE: 'mtls,oauth_client_credentials', ...MTLS })?.auth).toEqual(['mtls', 'oauth_client_credentials']);
  });
});

describe('§1.15 remote hash-signing adapter — globalsign-dss profile', () => {
  function gsVendor() {
    return fakeVendor((r) => {
      if (r.path === '/v2/login') return { body: { access_token: 'tok-1' } };
      if (r.path === '/v2/identity') return { body: { id: 'ident-1', signing_cert: test.certificate_pem, ocsp_response: '' } };
      if (r.path === '/v2/certificate_path') return { body: { path: test.certificate_pem } };
      const m = /^\/v2\/identity\/ident-1\/sign\/([0-9A-F]{64})$/.exec(r.path);
      if (m !== null) return { body: { signature: rawSign(Buffer.from(m[1] ?? '', 'hex')).toString('hex') } };
      return { status: 404, body: {} };
    });
  }

  it('logs in, issues an identity, signs the hash, and the sealed PDF validates', async () => {
    const settings = remoteHashSigningSettingsFromEnv(GS_ENV);
    if (settings === null) throw new Error('settings');
    const v = gsVendor();
    const provider = new RemoteHashSigningProvider(settings, v.transport);
    const r = await sealPdf(await executedPdf(), { provider, signing_time: new Date('2026-11-01T00:00:00Z') });
    verifySealedPdf(r.sealed_bytes, test.identity.certificate_der);

    expect(v.seen.map((s) => `${s.method} ${s.path.replace(/[0-9A-F]{64}$/, '<digest>')}`)).toEqual([
      'POST /v2/login',
      'POST /v2/identity',
      'GET /v2/certificate_path',
      'GET /v2/identity/ident-1/sign/<digest>',
    ]);
    expect(v.seen[0]?.json).toEqual({ api_key: 'k', api_secret: 's' });
    expect(v.seen[0]?.headers['authorization']).toBeUndefined();
    expect(v.seen[1]?.json).toEqual({ subject_dn: { common_name: 'Aramo Sign', organization: 'Aramo' } });
    expect(v.seen[1]?.headers['authorization']).toBe('Bearer tok-1');
    expect(r.signer_certificate_sha256).toBe(createHash('sha256').update(test.identity.certificate_der).digest('hex'));
  });

  it('reuses the token and the identity within their windows', async () => {
    const settings = remoteHashSigningSettingsFromEnv(GS_ENV);
    if (settings === null) throw new Error('settings');
    const v = gsVendor();
    let now = 1_000_000;
    const provider = new RemoteHashSigningProvider(settings, v.transport, () => now);
    await sealPdf(await executedPdf(), { provider, signing_time: new Date() });
    await sealPdf(await executedPdf(), { provider, signing_time: new Date() });
    expect(v.seen.filter((s) => s.path === '/v2/login')).toHaveLength(1);
    expect(v.seen.filter((s) => s.path === '/v2/identity')).toHaveLength(1);
    now += 301_000; // identity TTL 300 s
    await sealPdf(await executedPdf(), { provider, signing_time: new Date() });
    expect(v.seen.filter((s) => s.path === '/v2/identity')).toHaveLength(2);
  });

  it('an HTTP error surfaces status and path only (no body)', async () => {
    const settings = remoteHashSigningSettingsFromEnv(GS_ENV);
    if (settings === null) throw new Error('settings');
    const v = fakeVendor(() => ({ status: 401, body: { error: 'secret-echo' } }));
    const provider = new RemoteHashSigningProvider(settings, v.transport);
    const err = await provider.identity().catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(SealProviderHttpError);
    expect((err as Error).message).toBe('seal provider HTTP 401 on /v2/login');
  });

  it('a vendor signature that does not verify against the certificate fails the seal (closed)', async () => {
    const settings = remoteHashSigningSettingsFromEnv(GS_ENV);
    if (settings === null) throw new Error('settings');
    const v = fakeVendor((r) => {
      if (r.path === '/v2/login') return { body: { access_token: 't' } };
      if (r.path === '/v2/identity') return { body: { id: 'ident-1', signing_cert: test.certificate_pem } };
      if (r.path === '/v2/certificate_path') return { body: { path: test.certificate_pem } };
      return { body: { signature: '00'.repeat(256) } };
    });
    await expect(sealPdf(await executedPdf(), { provider: new RemoteHashSigningProvider(settings, v.transport), signing_time: new Date() })).rejects.toThrow(/does not verify/);
  });
});

describe('§1.15 remote hash-signing adapter — csc (Cloud Signature Consortium API v2) profile', () => {
  it('client-credentials token, credentials/info chain, authorize (SAD), signHash; the sealed PDF validates', async () => {
    const settings = remoteHashSigningSettingsFromEnv(CSC_ENV);
    if (settings === null) throw new Error('settings');
    const v = fakeVendor((r) => {
      if (r.path === '/oauth2/token') return { body: { access_token: 'tok', expires_in: 3600 } };
      if (r.path === '/csc/v2/credentials/info') return { body: { cert: { certificates: [test.identity.certificate_der.toString('base64')] } } };
      if (r.path === '/csc/v2/credentials/authorize') return { body: { SAD: 'sad-1' } };
      if (r.path === '/csc/v2/signatures/signHash') {
        const hash = Buffer.from(((r.json as { hashes: string[] }).hashes[0] ?? ''), 'base64');
        return { body: { signatures: [rawSign(hash).toString('base64')] } };
      }
      return { status: 404, body: {} };
    });
    const r = await sealPdf(await executedPdf(), { provider: new RemoteHashSigningProvider(settings, v.transport), signing_time: new Date() });
    verifySealedPdf(r.sealed_bytes, test.identity.certificate_der);
    expect(v.seen.map((s) => s.path)).toEqual(['/oauth2/token', '/csc/v2/credentials/info', '/csc/v2/credentials/authorize', '/csc/v2/signatures/signHash']);
    expect(v.seen[0]?.form).toEqual({ grant_type: 'client_credentials', client_id: 'client', client_secret: 'secret' });
    expect(v.seen[1]?.json).toEqual({ credentialID: 'cred-1', certificates: 'chain', certInfo: false });
    expect(v.seen[3]?.json).toMatchObject({ credentialID: 'cred-1', SAD: 'sad-1', hashAlgorithmOID: '2.16.840.1.101.3.4.2.1', signAlgo: '1.2.840.113549.1.1.1' });
  });
});
