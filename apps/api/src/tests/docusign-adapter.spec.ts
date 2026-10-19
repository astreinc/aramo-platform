import { createHash, createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';

import { DocuSignAdapter } from '../esignature-providers/docusign/docusign.adapter.js';
import { DOCUSIGN_EVIDENCE_KIND, verifyDocuSignHmac, parseDocuSignEvent } from '../esignature-providers/docusign/docusign-connect.js';
import type { DocuSignConfig } from '../esignature-providers/docusign/docusign.config.js';
import type { ProviderCredentialStore, ProviderTokens } from '../esignature-providers/provider-credential-store.js';

// Multi-Provider directive §G — DocuSign adapter, contract-tested against the
// documented eSignature REST v2.1 + OAuth (Authorization Code + PKCE) + Connect
// HMAC behaviour. Live sandbox validation is pending (no sandbox credentials).

const CONFIG: DocuSignConfig = {
  integrationKey: 'ik-123',
  clientSecret: 'secret-456',
  oauthBaseUrl: 'https://account-d.docusign.com',
  redirectUri: 'https://astre.aramo.ai/v1/integrations/esignature/docusign/callback',
  webhookUrl: 'https://astre.aramo.ai/v1/webhooks/esignature/docusign',
  connectHmacKey: 'hmac-key',
};
const T = '0190dddd-0000-7000-8000-000000000001';
const FRESH: ProviderTokens = { access_token: 'at-1', refresh_token: 'rt-1', expires_at: Date.now() + 3_600_000, account_id: 'acct-1', base_uri: 'https://demo.docusign.net' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function pdf(pages: number): Promise<string> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) d.addPage([612, 792]);
  return Buffer.from(await d.save()).toString('base64');
}

function make(opts: { tokens?: ProviderTokens | null; responses?: ((url: string, init?: RequestInit) => Response | undefined)[]; source?: string } = {}) {
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
    save: vi.fn(async (_t: string, _p: string, next: ProviderTokens, accountId: string) => { tokens = next; void accountId; }),
    markDegraded: vi.fn(async () => undefined),
    state: vi.fn(async () => (tokens === null ? 'NOT_CONNECTED' : 'CONNECTED')),
    disconnect: vi.fn(async () => undefined),
    accountMatches: vi.fn(async () => true),
  } as unknown as ProviderCredentialStore;
  const routes = { findRoute: vi.fn(async () => ({ provider: 'docusign', provider_envelope_ref: 'env-9', created_at: new Date() })) };
  const source = { getSourceBase64: vi.fn(async () => opts.source ?? null) };
  const adapter = new DocuSignAdapter(CONFIG, store, routes as never, source as never, fetchFn as unknown as typeof fetch);
  return { adapter, calls, store, source };
}

describe('DocuSign OAuth (Authorization Code + PKCE)', () => {
  it('builds the authorize URL with the state and an S256 code challenge', () => {
    const url = new URL(make().adapter.authorizeUrl({ state: 'st-1', code_verifier: 'v'.repeat(64) }));
    expect(url.origin + url.pathname).toBe('https://account-d.docusign.com/oauth/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: 'code',
      client_id: 'ik-123',
      state: 'st-1',
      redirect_uri: CONFIG.redirectUri,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'),
    });
  });

  it('exchanges the code with the verifier, reads the default account, and stores the tokens', async () => {
    const { adapter, calls, store } = make({
      tokens: null,
      responses: [
        (u) => (u.endsWith('/oauth/token') ? json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 28800 }) : undefined),
        (u) => (u.endsWith('/oauth/userinfo') ? json({ accounts: [{ account_id: 'a-2', base_uri: 'https://na2.docusign.net', is_default: false }, { account_id: 'a-1', base_uri: 'https://demo.docusign.net', is_default: true }] }) : undefined),
      ],
    });
    await adapter.completeAuthorization({ tenant_id: T, code: 'code-1', code_verifier: 'ver-1' });
    const tokenCall = calls.find((c) => c.url.endsWith('/oauth/token'));
    expect(String(tokenCall?.init?.body)).toContain('grant_type=authorization_code');
    expect(String(tokenCall?.init?.body)).toContain('code_verifier=ver-1');
    expect((tokenCall?.init?.headers as Record<string, string>)['authorization']).toBe(`Basic ${Buffer.from('ik-123:secret-456').toString('base64')}`);
    expect(store.save).toHaveBeenCalledWith(T, 'docusign', expect.objectContaining({ access_token: 'at-new', account_id: 'a-1', base_uri: 'https://demo.docusign.net' }), 'a-1');
  });

  it('refreshes an expired access token before calling the API', async () => {
    const { adapter, calls, store } = make({
      tokens: { ...FRESH, expires_at: Date.now() - 1 },
      responses: [
        (u) => (u.endsWith('/oauth/token') ? json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 28800 }) : undefined),
        (u) => (u.includes('/envelopes/env-1') ? json({ envelopeId: 'env-1', status: 'sent' }) : undefined),
      ],
    });
    await adapter.getEnvelope(T, 'env-1');
    expect(String(calls[0]?.init?.body)).toContain('grant_type=refresh_token');
    expect(store.save).toHaveBeenCalled();
    expect((calls[1]?.init?.headers as Record<string, string>)['authorization']).toBe('Bearer at-2');
  });

  it('a revoked refresh token marks the connection degraded and reads PROVIDER_DISCONNECTED', async () => {
    const { adapter, store } = make({
      tokens: { ...FRESH, expires_at: Date.now() - 1 },
      responses: [(u) => (u.endsWith('/oauth/token') ? json({ error: 'invalid_grant' }, 400) : undefined)],
    });
    await expect(adapter.getEnvelope(T, 'env-1')).rejects.toMatchObject({ code: 'ESIGN_SEND_UNAVAILABLE', context: { details: { reason: 'PROVIDER_DISCONNECTED', provider: 'docusign' } } });
    expect(store.markDegraded).toHaveBeenCalled();
  });
});

describe('DocuSign envelopes', () => {
  it('creates a draft with the frozen PDF and a signature tab on the last page, then sends it', async () => {
    const { adapter, calls } = make({
      source: await pdf(3),
      responses: [
        (u, i) => (u.endsWith('/envelopes') && i?.method === 'POST' ? json({ envelopeId: 'env-1', status: 'created' }, 201) : undefined),
        (u, i) => (u.endsWith('/envelopes/env-1') && i?.method === 'PUT' ? json({ envelopeId: 'env-1' }) : undefined),
        (u) => (u.includes('/envelopes/env-1') ? json({ envelopeId: 'env-1', status: 'sent', recipients: { signers: [{ recipientId: '1', email: 'ravi@x.test', status: 'sent' }] } }) : undefined),
      ],
    });
    const created = await adapter.createEnvelope({
      tenant_id: T, subject: 'Right to Represent', execution_mode: 'SINGLE_SIGNATURE', created_by: 'u1',
      documents: [{ document_ref: 'doc-1', document_revision_ref: 'rev-1', source_sha256: 'x', title: 'RTR', ordinal: 1 }],
      signers: [{ email: 'ravi@x.test', name: 'Ravi', signing_order: 1 }],
    });
    expect(created).toMatchObject({ envelope_id: 'env-1', status: 'DRAFT' });
    const body = JSON.parse(String(calls[0]?.init?.body)) as { status: string; documents: { documentBase64: string }[]; recipients: { signers: { tabs: { signHereTabs: { pageNumber: string }[] } }[] } };
    expect(calls[0]?.url).toBe('https://demo.docusign.net/restapi/v2.1/accounts/acct-1/envelopes');
    expect(body.status).toBe('created');
    expect(body.documents[0]?.documentBase64.length).toBeGreaterThan(10);
    expect(body.recipients.signers[0]?.tabs.signHereTabs[0]?.pageNumber).toBe('3');
    // Completion callbacks are requested on the envelope itself, so no tenant has to
    // configure Connect in their own DocuSign account.
    expect((body as unknown as { eventNotification: unknown }).eventNotification).toEqual({
      url: 'https://astre.aramo.ai/v1/webhooks/esignature/docusign',
      loggingEnabled: 'true',
      requireAcknowledgment: 'true',
      includeHMAC: 'false',
      deliveryMode: 'SIM',
      eventData: { version: 'restv2.1', format: 'json' },
      events: ['envelope-completed'],
    });
    const sent = await adapter.sendEnvelope(T, 'env-1');
    expect(JSON.parse(String(calls.find((c) => c.init?.method === 'PUT')?.init?.body))).toEqual({ status: 'sent' });
    expect(sent.status).toBe('SENT');
  });

  it('a provider refusal is a typed PROVIDER_REFUSED failure, never a silent fallback', async () => {
    const { adapter } = make({ responses: [(u) => (u.endsWith('/envelopes/env-1') ? json({ errorCode: 'ACCOUNT_LACKS_PERMISSIONS', message: 'no' }, 400) : undefined)] });
    await expect(adapter.sendEnvelope(T, 'env-1')).rejects.toMatchObject({
      code: 'ESIGN_SEND_UNAVAILABLE',
      context: { details: { reason: 'PROVIDER_REFUSED', provider: 'docusign', provider_error: 'ACCOUNT_LACKS_PERMISSIONS' } },
    });
  });

  it('a provider outage is PROVIDER_UNAVAILABLE', async () => {
    const { adapter } = make({ responses: [() => new Response('down', { status: 503 })] });
    await expect(adapter.getEnvelope(T, 'env-1')).rejects.toMatchObject({ context: { details: { reason: 'PROVIDER_UNAVAILABLE' } } });
  });

  it('reminders resend to the current signers', async () => {
    const { adapter, calls } = make({
      responses: [
        (u, i) => (u.includes('/recipients') && i?.method === 'PUT' ? json({}) : undefined),
        (u) => (u.endsWith('/envelopes/env-1/recipients') ? json({ signers: [{ recipientId: '1', email: 'ravi@x.test', name: 'Ravi', status: 'sent' }] }) : undefined),
        (u) => (u.includes('/envelopes/env-1') ? json({ envelopeId: 'env-1', status: 'sent' }) : undefined),
      ],
    });
    await adapter.remindEnvelopeSigner(T, 'env-1');
    const put = calls.find((c) => c.init?.method === 'PUT');
    expect(put?.url).toContain('/envelopes/env-1/recipients?resend_envelope=true');
    expect(JSON.parse(String(put?.init?.body))).toEqual({ signers: [{ recipientId: '1', email: 'ravi@x.test', name: 'Ravi' }] });
  });

  it('a completed envelope yields the combined PDF and the Certificate of Completion under its own kind', async () => {
    const { adapter } = make({
      responses: [
        (u) => (u.endsWith('/envelopes/env-1') ? json({ envelopeId: 'env-1', status: 'completed' }) : undefined),
        (u) => (u.endsWith('/documents/combined') ? new Response(Buffer.from('SIGNED')) : undefined),
        (u) => (u.endsWith('/documents/certificate') ? new Response(Buffer.from('COC')) : undefined),
      ],
    });
    const c = await adapter.fetchCompletion(T, 'env-1');
    expect(c).toEqual({ executed_pdf: Buffer.from('SIGNED'), evidence_pdf: Buffer.from('COC'), evidence_kind: DOCUSIGN_EVIDENCE_KIND });
  });

  it('a not-yet-completed envelope yields no completion (the webhook payload is never trusted alone)', async () => {
    const { adapter } = make({ responses: [(u) => (u.endsWith('/envelopes/env-1') ? json({ envelopeId: 'env-1', status: 'sent' }) : undefined)] });
    expect(await adapter.fetchCompletion(T, 'env-1')).toBeNull();
  });
});

describe('DocuSign Connect (webhook) verification', () => {
  const body = Buffer.from(JSON.stringify({ event: 'envelope-completed', data: { accountId: 'acct-1', envelopeId: 'env-1' } }));
  const sig = (key: string, b: Buffer) => createHmac('sha256', key).update(b).digest('base64');

  it('accepts any one matching X-DocuSign-Signature-N computed over the raw body', () => {
    expect(verifyDocuSignHmac(body, { 'x-docusign-signature-1': 'nope', 'x-docusign-signature-2': sig('hmac-key', body) }, 'hmac-key')).toBe(true);
  });

  it('rejects a missing, wrong or re-serialized signature', () => {
    expect(verifyDocuSignHmac(body, {}, 'hmac-key')).toBe(false);
    expect(verifyDocuSignHmac(body, { 'x-docusign-signature-1': sig('other', body) }, 'hmac-key')).toBe(false);
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(verifyDocuSignHmac(body, { 'x-docusign-signature-1': sig('hmac-key', reserialized) }, 'hmac-key')).toBe(false);
  });

  it('parses both the wrapped (data.*) and flat Connect payload shapes', () => {
    expect(parseDocuSignEvent(body)).toEqual({ event: 'envelope-completed', account_id: 'acct-1', envelope_id: 'env-1' });
    expect(parseDocuSignEvent(Buffer.from(JSON.stringify({ event: 'envelope-completed', accountId: 'a', envelopeId: 'e' })))).toEqual({ event: 'envelope-completed', account_id: 'a', envelope_id: 'e' });
    expect(parseDocuSignEvent(Buffer.from('not json'))).toBeNull();
  });
});
