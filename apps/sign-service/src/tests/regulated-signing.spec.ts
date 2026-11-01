import { describe, expect, it } from 'vitest';
import { DisabledEstampAdapter, DisabledQesSigningAdapter, EstampProviderNotConfiguredError, QesProviderError, QesProviderNotConfiguredError, RegulatedSigningStateError, RegulatedSigningValidationError } from '@aramo/sign';
import { FEATURE_AVAILABILITY } from '@aramo/subscription';

import { CscQesSigningAdapter, qesSigningAdapterFromEnv } from '../app/regulated/csc-qes-signing.adapter.js';
import { estampAdapterFromEnv } from '../app/regulated/estamp-adapter.js';
import { regulatedHttp } from '../app/regulated/regulated-http.js';
import { qesRedirectUri } from '../app/regulated/regulated-signing.service.js';

// Feature-Parity §1.16 / §1.19 (Amendment A1) — composition-root adapters, the generic CSC
// adapter against a stub (no live QTSP is called), the error mapping and the dark gate.

const CONFIG = { base_url: 'https://qtsp.example/csc/v2/', oauth_url: 'https://qtsp.example/oauth2', client_id: 'aramo', client_secret: 's3cret' };
const CERT_B64 = 'MIIBszCCAVmgAwIBAgIUQ';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}
function stub(responses: Record<string, { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init.headers, body: init.body ?? '' });
    const key = Object.keys(responses).find((k) => url.endsWith(k));
    if (key === undefined) throw new Error('network down');
    const r = responses[key]!;
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json };
  };
  return { calls, fetchFn };
}

describe('feature availability', () => {
  it('keeps sign.qes and sign.india_estamp NOT_AVAILABLE', () => {
    expect(FEATURE_AVAILABILITY['sign.qes']).toBe('NOT_AVAILABLE');
    expect(FEATURE_AVAILABILITY['sign.india_estamp']).toBe('NOT_AVAILABLE');
  });
});

describe('adapters from env', () => {
  it('QES is disabled unless SIGN_QES_PROVIDER=csc is complete and https', () => {
    expect(qesSigningAdapterFromEnv({})).toBeInstanceOf(DisabledQesSigningAdapter);
    expect(qesSigningAdapterFromEnv({ SIGN_QES_PROVIDER: 'csc' })).toBeInstanceOf(DisabledQesSigningAdapter);
    const full = { SIGN_QES_PROVIDER: 'CSC', SIGN_QES_CSC_BASE_URL: 'https://q/csc/v2', SIGN_QES_CSC_OAUTH_URL: 'https://q/oauth2', SIGN_QES_CSC_CLIENT_ID: 'id', SIGN_QES_CSC_CLIENT_SECRET: 'secret' };
    expect(qesSigningAdapterFromEnv(full)).toBeInstanceOf(CscQesSigningAdapter);
    expect(qesSigningAdapterFromEnv({ ...full, SIGN_QES_CSC_BASE_URL: 'http://q/csc/v2' })).toBeInstanceOf(DisabledQesSigningAdapter);
    expect(qesSigningAdapterFromEnv({ ...full, SIGN_QES_CSC_CLIENT_SECRET: ' ' })).toBeInstanceOf(DisabledQesSigningAdapter);
    expect(qesSigningAdapterFromEnv({ ...full, SIGN_QES_PROVIDER: 'other' })).toBeInstanceOf(DisabledQesSigningAdapter);
  });
  it('e-stamp is always disabled (no aggregator adapter exists)', () => {
    expect(estampAdapterFromEnv({})).toBeInstanceOf(DisabledEstampAdapter);
    expect(estampAdapterFromEnv({ SIGN_ESTAMP_PROVIDER: 'anything' })).toBeInstanceOf(DisabledEstampAdapter);
  });
  it('the QTSP redirect URI hangs off the Sign base URL', () => {
    expect(qesRedirectUri({ ARAMO_SIGN_BASE_URL: 'https://sign.example/' })).toBe('https://sign.example/qes/callback');
    expect(qesRedirectUri({})).toBe('https://sign.aramo.ai/qes/callback');
  });
});

describe('CscQesSigningAdapter (stubbed CSC API v2)', () => {
  it('builds the identity authorize URL (scope service)', async () => {
    const a = new CscQesSigningAdapter(CONFIG, stub({}).fetchFn);
    const { redirect_url } = await a.beginIdentity({ state: 'st', redirect_uri: 'https://sign.example/qes/callback', signer: { name: 'A', email: 'a@example.com' } });
    const u = new URL(redirect_url);
    expect(u.origin + u.pathname).toBe('https://qtsp.example/oauth2/authorize');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ response_type: 'code', client_id: 'aramo', scope: 'service', state: 'st', login_hint: 'a@example.com' });
  });
  it('exchanges the code and reads the credential and its chain', async () => {
    const s = stub({
      '/oauth2/token': { json: { access_token: 'tok' } },
      '/credentials/list': { json: { credentialIDs: ['cred-1'], credentialInfos: [{ credentialID: 'cred-1', key: { algo: ['1.2.840.113549.1.1.11'] }, cert: { certificates: [CERT_B64] }, SCAL: '2' }] } },
    });
    const a = new CscQesSigningAdapter(CONFIG, s.fetchFn);
    const c = await a.completeIdentity({ authorization_code: 'code', redirect_uri: 'https://sign.example/qes/callback' });
    expect(c).toEqual({ credential_id: 'cred-1', certificate_chain_pem: [`-----BEGIN CERTIFICATE-----\n${CERT_B64}\n-----END CERTIFICATE-----`], signature_algorithm_oids: ['1.2.840.113549.1.1.11'], authorization_level: '2' });
    expect(s.calls[0]!.url).toBe('https://qtsp.example/oauth2/token');
    expect(new URLSearchParams(s.calls[0]!.body).get('grant_type')).toBe('authorization_code');
    expect(s.calls[1]!.url).toBe('https://qtsp.example/csc/v2/credentials/list');
    expect(s.calls[1]!.headers['Authorization']).toBe('Bearer tok');
  });
  it('falls back to credentials/info when the list carries no chain', async () => {
    const s = stub({
      '/oauth2/token': { json: { access_token: 'tok' } },
      '/credentials/list': { json: { credentialIDs: ['cred-1'] } },
      '/credentials/info': { json: { key: { algo: [] }, cert: { certificates: [CERT_B64] } } },
    });
    const c = await new CscQesSigningAdapter(CONFIG, s.fetchFn).completeIdentity({ authorization_code: 'code', redirect_uri: 'r' });
    expect(c.credential_id).toBe('cred-1');
    expect(c.authorization_level).toBeNull();
    expect(s.calls.map((x) => x.url.split('/').pop())).toEqual(['token', 'list', 'info']);
  });
  it('binds the signature authorization to the hash (scope credential, base64url)', async () => {
    const a = new CscQesSigningAdapter(CONFIG, stub({}).fetchFn);
    const { redirect_url } = await a.beginSignature({ state: 'st2', redirect_uri: 'r', credential_id: 'cred-1', hash_b64: 'ab+/cd==', hash_algorithm_oid: '2.16.840.1.101.3.4.2.1' });
    const q = new URL(redirect_url).searchParams;
    expect(q.get('scope')).toBe('credential');
    expect(q.get('credentialID')).toBe('cred-1');
    expect(q.get('numSignatures')).toBe('1');
    expect(q.get('hashes')).toBe('ab-_cd');
  });
  it('signs the hash and returns the signature', async () => {
    const s = stub({ '/oauth2/token': { json: { access_token: 'tok2' } }, '/signatures/signHash': { json: { signatures: ['c2ln'], responseID: 'resp-9' } } });
    const r = await new CscQesSigningAdapter(CONFIG, s.fetchFn).signHash({ authorization_code: 'c', redirect_uri: 'r', credential_id: 'cred-1', hash_b64: 'aGFzaA==', hash_algorithm_oid: 'h', signature_algorithm_oid: 's' });
    expect(r).toEqual({ signature_b64: 'c2ln', qtsp_reference: 'resp-9' });
    expect(JSON.parse(s.calls[1]!.body)).toMatchObject({ credentialID: 'cred-1', hashes: ['aGFzaA=='], signAlgo: 's', operationMode: 'S' });
  });
  it('maps refusals and outages to short reasons without echoing the body', async () => {
    const refused = stub({ '/oauth2/token': { status: 401, json: { error: 'invalid_grant', error_description: 'secret detail' } } });
    const err = await new CscQesSigningAdapter(CONFIG, refused.fetchFn).completeIdentity({ authorization_code: 'c', redirect_uri: 'r' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QesProviderError);
    expect((err as QesProviderError).reason).toBe('qtsp_http_401');
    expect((err as Error).message).not.toContain('secret detail');
    const down = await new CscQesSigningAdapter(CONFIG, stub({}).fetchFn).signHash({ authorization_code: 'c', redirect_uri: 'r', credential_id: 'x', hash_b64: 'x', hash_algorithm_oid: 'h', signature_algorithm_oid: 's' }).catch((e: unknown) => e);
    expect((down as QesProviderError).reason).toBe('qtsp_unreachable');
    const empty = stub({ '/oauth2/token': { json: { access_token: 't' } }, '/credentials/list': { json: { credentialIDs: [] } } });
    const none = await new CscQesSigningAdapter(CONFIG, empty.fetchFn).completeIdentity({ authorization_code: 'c', redirect_uri: 'r' }).catch((e: unknown) => e);
    expect((none as QesProviderError).reason).toBe('qtsp_no_credential');
  });
});

describe('regulatedHttp', () => {
  it('maps onto existing error codes only', () => {
    const notConfigured = regulatedHttp(new QesProviderNotConfiguredError(), 'r1');
    expect(notConfigured?.code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
    expect(notConfigured?.statusCode).toBe(403);
    expect(regulatedHttp(new EstampProviderNotConfiguredError(), 'r1')?.code).toBe('ESIGN_FEATURE_NOT_AVAILABLE');
    const invalid = regulatedHttp(new RegulatedSigningValidationError('state_code', 'bad'), 'r1');
    expect([invalid?.code, invalid?.statusCode]).toEqual(['VALIDATION_ERROR', 400]);
    const state = regulatedHttp(new RegulatedSigningStateError('estamp_not_attached'), 'r1');
    expect([state?.code, state?.statusCode]).toEqual(['ENVELOPE_ILLEGAL_TRANSITION', 409]);
    expect(regulatedHttp(new QesProviderError('qtsp_http_500'), 'r1')?.code).toBe('ENVELOPE_ILLEGAL_TRANSITION');
    expect(regulatedHttp(new Error('other'), 'r1')).toBeNull();
  });
});
