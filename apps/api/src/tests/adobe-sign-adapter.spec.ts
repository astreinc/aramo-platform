import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';

import { AdobeSignAdapter } from '../esignature-providers/adobe-sign/adobe-sign.adapter.js';
import { ADOBE_SIGN_EVIDENCE_KIND, isAdobeSignHost } from '../esignature-providers/adobe-sign/adobe-sign-webhook.js';
import { AdobeSignWebhookController } from '../esignature-providers/adobe-sign/adobe-sign-webhook.controller.js';
import type { AdobeSignConfig } from '../esignature-providers/adobe-sign/adobe-sign.config.js';
import type { ProviderCompletionService } from '../esignature-providers/provider-completion.service.js';
import type { ProviderCredentialStore, ProviderTokens } from '../esignature-providers/provider-credential-store.js';

// Multi-Provider directive §G — Adobe Acrobat Sign adapter, contract-tested against
// the documented REST v6 + OAuth v2 + webhook (client-id echo) behaviour. Live
// sandbox validation is pending (no developer-account credentials).

const CONFIG: AdobeSignConfig = {
  clientId: 'cid-1',
  clientSecret: 'csec-1',
  oauthBaseUrl: 'https://secure.na1.adobesign.com',
  redirectUri: 'https://astre.aramo.ai/v1/integrations/esignature/adobe_sign/callback',
  webhookUrl: 'https://astre.aramo.ai/v1/webhooks/esignature/adobe-sign',
};
const T = '0190ffff-0000-7000-8000-000000000001';
const API = 'https://api.na1.adobesign.com/';
const FRESH: ProviderTokens = { access_token: 'at-1', refresh_token: 'rt-1', expires_at: Date.now() + 3_600_000, account_id: 'acc-1', base_uri: API };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

function make(opts: { tokens?: ProviderTokens | null; responses?: ((u: string, i?: RequestInit) => Response | undefined)[] } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const r of opts.responses ?? []) {
      const res = r(url, init);
      if (res) return res;
    }
    return json({}, 404);
  });
  let tokens = opts.tokens === undefined ? FRESH : opts.tokens;
  const store = {
    load: vi.fn(async () => tokens),
    save: vi.fn(async (_t: string, _p: string, next: ProviderTokens) => { tokens = next; }),
    markDegraded: vi.fn(async () => undefined),
    state: vi.fn(async () => 'CONNECTED'),
    disconnect: vi.fn(async () => undefined),
  } as unknown as ProviderCredentialStore;
  const routes = { findRoute: vi.fn(async () => ({ provider: 'adobe_sign', provider_envelope_ref: 'agr-1' })) };
  const source = { getSourceBase64: vi.fn(async () => Buffer.from('%PDF-1.4 test').toString('base64')) };
  return { adapter: new AdobeSignAdapter(CONFIG, store, routes as never, source as never, fetchFn as unknown as typeof fetch), calls, store };
}

describe('Adobe Acrobat Sign OAuth v2', () => {
  it('builds the authorize URL with the state and the agreement + webhook scopes', () => {
    const u = new URL(make().adapter.authorizeUrl({ state: 'st-1', code_verifier: 'unused' }));
    expect(u.origin + u.pathname).toBe('https://secure.na1.adobesign.com/public/oauth/v2');
    expect(u.searchParams.get('state')).toBe('st-1');
    expect(u.searchParams.get('client_id')).toBe('cid-1');
    expect(u.searchParams.get('scope')).toContain('agreement_send:account');
  });

  it('only trusts Adobe Sign hosts as the api_access_point (no token or secret sent elsewhere)', async () => {
    expect(isAdobeSignHost('https://api.na1.adobesign.com/')).toBe(true);
    expect(isAdobeSignHost('https://api.eu1.adobesign.com/')).toBe(true);
    expect(isAdobeSignHost('https://evil.example/')).toBe(false);
    expect(isAdobeSignHost('https://adobesign.com.evil.example/')).toBe(false);
    expect(isAdobeSignHost('http://api.na1.adobesign.com/')).toBe(false);
    const { adapter, calls } = make({ tokens: null });
    await expect(adapter.completeAuthorization({ tenant_id: T, code: 'c', code_verifier: 'v', callback_params: { api_access_point: 'https://evil.example/' } })).rejects.toMatchObject({ context: { details: { reason: 'PROVIDER_REFUSED' } } });
    expect(calls).toHaveLength(0);
  });

  it('exchanges the code at the account api_access_point, reads the account, registers the completion webhook and stores tokens', async () => {
    const { adapter, calls, store } = make({
      tokens: null,
      responses: [
        (u) => (u === `${API}oauth/v2/token` ? json({ access_token: 'at-n', refresh_token: 'rt-n', expires_in: 3600 }) : undefined),
        (u) => (u === `${API}api/rest/v6/users/me` ? json({ id: 'user-1', accountId: 'acc-9' }) : undefined),
        (u, i) => (u === `${API}api/rest/v6/webhooks` && i?.method === 'POST' ? json({ id: 'wh-1' }, 201) : undefined),
      ],
    });
    await adapter.completeAuthorization({ tenant_id: T, code: 'code-1', code_verifier: 'v', callback_params: { api_access_point: API } });
    expect(String(calls[0]?.init?.body)).toContain('grant_type=authorization_code');
    expect(String(calls[0]?.init?.body)).toContain('client_secret=csec-1');
    const wh = JSON.parse(String(calls[2]?.init?.body)) as { webhookSubscriptionEvents: string[]; webhookUrlInfo: { url: string } };
    expect(wh.webhookSubscriptionEvents).toEqual(['AGREEMENT_WORKFLOW_COMPLETED']);
    expect(wh.webhookUrlInfo.url).toBe(CONFIG.webhookUrl);
    expect(store.save).toHaveBeenCalledWith(T, 'adobe_sign', expect.objectContaining({ access_token: 'at-n', account_id: 'acc-9', base_uri: API }), 'acc-9');
  });

  it('refreshes at /oauth/v2/refresh; a rejected refresh marks the connection degraded', async () => {
    const ok = make({ tokens: { ...FRESH, expires_at: 0 }, responses: [
      (u) => (u === `${API}oauth/v2/refresh` ? json({ access_token: 'at-2', expires_in: 3600 }) : undefined),
      (u) => (u.includes('/agreements/agr-1') ? json({ id: 'agr-1', status: 'OUT_FOR_SIGNATURE' }) : undefined),
    ] });
    await expect(ok.adapter.getEnvelope(T, 'agr-1')).resolves.toMatchObject({ status: 'SENT' });
    expect(String(ok.calls[0]?.init?.body)).toContain('grant_type=refresh_token');
    const bad = make({ tokens: { ...FRESH, expires_at: 0 }, responses: [(u) => (u.endsWith('oauth/v2/refresh') ? json({ error: 'invalid_request' }, 400) : undefined)] });
    await expect(bad.adapter.getEnvelope(T, 'agr-1')).rejects.toMatchObject({ context: { details: { reason: 'PROVIDER_DISCONNECTED', provider: 'adobe_sign' } } });
    expect(bad.store.markDegraded).toHaveBeenCalled();
  });

  it('disconnect revokes the refresh token at Adobe, then tombstones custody', async () => {
    const { adapter, calls, store } = make({ responses: [(u) => (u === `${API}oauth/v2/revoke` ? new Response(null, { status: 200 }) : undefined)] });
    await adapter.disconnect(T);
    expect(String(calls[0]?.init?.body)).toContain('token=rt-1');
    expect(store.disconnect).toHaveBeenCalledWith(T, 'adobe_sign');
  });
});

describe('Adobe Acrobat Sign agreements', () => {
  it('uploads the frozen PDF as a transient document, creates a DRAFT agreement, then sends it IN_PROCESS', async () => {
    const { adapter, calls } = make({ responses: [
      (u) => (u.endsWith('/transientDocuments') ? json({ transientDocumentId: 'td-1' }, 201) : undefined),
      (u, i) => (u.endsWith('/agreements') && i?.method === 'POST' ? json({ id: 'agr-1' }, 201) : undefined),
      (u, i) => (u.endsWith('/agreements/agr-1/state') && i?.method === 'PUT' ? new Response(null, { status: 204 }) : undefined),
      (u) => (u.endsWith('/agreements/agr-1') ? json({ id: 'agr-1', status: 'OUT_FOR_SIGNATURE' }) : undefined),
    ] });
    const created = await adapter.createEnvelope({
      tenant_id: T, subject: 'Offer Letter', execution_mode: 'SINGLE_SIGNATURE', created_by: 'u',
      documents: [{ document_ref: 'doc-1', document_revision_ref: 'rev-1', source_sha256: 'x', title: 'Offer', ordinal: 1 }],
      signers: [{ email: 'ravi@x.test', name: 'Ravi', signing_order: 1 }],
    });
    expect(created).toMatchObject({ envelope_id: 'agr-1', status: 'DRAFT' });
    expect(calls[0]?.init?.body).toBeInstanceOf(FormData);
    const agreement = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(agreement).toMatchObject({
      fileInfos: [{ transientDocumentId: 'td-1' }],
      participantSetsInfo: [{ memberInfos: [{ email: 'ravi@x.test' }], order: 1, role: 'SIGNER' }],
      signatureType: 'ESIGN',
      state: 'DRAFT',
    });
    await expect(adapter.sendEnvelope(T, 'agr-1')).resolves.toMatchObject({ status: 'SENT' });
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/state'))?.init?.body))).toEqual({ state: 'IN_PROCESS' });
  });

  it('void cancels with a comment; reminders go to the current participants', async () => {
    const { adapter, calls } = make({ responses: [
      (u, i) => (u.endsWith('/state') && i?.method === 'PUT' ? new Response(null, { status: 204 }) : undefined),
      (u) => (u.endsWith('/members') ? json({ nextParticipantSets: [{ memberInfos: [{ id: 'p-1', email: 'ravi@x.test' }] }] }) : undefined),
      (u, i) => (u.endsWith('/reminders') && i?.method === 'POST' ? json({ id: 'r-1' }, 201) : undefined),
      (u) => (u.endsWith('/agreements/agr-1') ? json({ id: 'agr-1', status: 'CANCELLED' }) : undefined),
    ] });
    await expect(adapter.voidEnvelope(T, 'agr-1', 'Wrong rate')).resolves.toMatchObject({ status: 'VOIDED' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ state: 'CANCELLED', agreementCancellationInfo: { comment: 'Wrong rate', notifyOthers: true } });
    await adapter.remindEnvelopeSigner(T, 'agr-1');
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/reminders'))?.init?.body))).toEqual({ recipientParticipantIds: ['p-1'], status: 'ACTIVE' });
  });

  it('a signed agreement yields the combined document and the audit report under its own kind', async () => {
    const { adapter } = make({ responses: [
      (u) => (u.endsWith('/agreements/agr-1') ? json({ id: 'agr-1', status: 'SIGNED' }) : undefined),
      (u) => (u.endsWith('/combinedDocument') ? new Response(Buffer.from('SIGNED')) : undefined),
      (u) => (u.endsWith('/auditTrail') ? new Response(Buffer.from('AUDIT')) : undefined),
    ] });
    expect(await adapter.fetchCompletion(T, 'agr-1')).toEqual({ executed_pdf: Buffer.from('SIGNED'), evidence_pdf: Buffer.from('AUDIT'), evidence_kind: ADOBE_SIGN_EVIDENCE_KIND });
  });

  it('a provider refusal is PROVIDER_REFUSED with Adobe’s code', async () => {
    const { adapter } = make({ responses: [(u) => (u.endsWith('/state') ? json({ code: 'INVALID_STATE', message: 'no' }, 400) : undefined)] });
    await expect(adapter.sendEnvelope(T, 'agr-1')).rejects.toMatchObject({ context: { details: { reason: 'PROVIDER_REFUSED', provider_error: 'INVALID_STATE' } } });
  });
});

describe('Adobe Acrobat Sign webhook (client-id verification of intent)', () => {
  async function call(method: 'GET' | 'POST', headers: Record<string, string>, body: unknown = {}, config: AdobeSignConfig | null = CONFIG) {
    const completion = { handle: vi.fn(async () => 'PROCESSED') } as unknown as ProviderCompletionService;
    const ctl = new AdobeSignWebhookController(completion, config);
    const sent: Record<string, string> = {};
    let status = 0;
    const res = { status: (s: number) => { status = s; return res; }, setHeader: (k: string, v: string) => { sent[k.toLowerCase()] = v; } } as unknown as Response;
    const req = { headers, body } as unknown as Request;
    const out = method === 'GET' ? await ctl.verify(req, res) : await ctl.notify(req, res);
    return { status, sent, out, completion };
  }

  it('echoes our client id on the registration check, and refuses any other client id', async () => {
    const ok = await call('GET', { 'x-adobesign-clientid': 'cid-1' });
    expect(ok.status).toBe(200);
    expect(ok.sent['x-adobesign-clientid']).toBe('cid-1');
    expect(ok.out).toEqual({ xAdobeSignClientId: 'cid-1' });
    expect((await call('GET', { 'x-adobesign-clientid': 'someone-else' })).status).toBe(403);
    expect((await call('GET', {}, {}, null)).status).toBe(503);
  });

  it('a completed-agreement notification is handled and acknowledged with the echo', async () => {
    const r = await call('POST', { 'x-adobesign-clientid': 'cid-1' }, { event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'agr-1' } });
    expect(r.status).toBe(200);
    expect(r.sent['x-adobesign-clientid']).toBe('cid-1');
    expect(r.completion.handle).toHaveBeenCalledWith(expect.objectContaining({ provider: 'adobe_sign', provider_account_id: null, envelope_ref: 'agr-1' }));
  });

  it('a notification with a foreign client id is refused before anything is read', async () => {
    const r = await call('POST', { 'x-adobesign-clientid': 'someone-else' }, { event: 'AGREEMENT_WORKFLOW_COMPLETED', agreement: { id: 'agr-1' } });
    expect(r.status).toBe(403);
    expect(r.completion.handle).not.toHaveBeenCalled();
  });

  it('other events are acknowledged without action', async () => {
    const r = await call('POST', { 'x-adobesign-clientid': 'cid-1' }, { event: 'AGREEMENT_CREATED', agreement: { id: 'agr-1' } });
    expect(r.status).toBe(200);
    expect(r.completion.handle).not.toHaveBeenCalled();
  });
});
