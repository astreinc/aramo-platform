import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import type { DocumentExecutedWriteBackService } from '@aramo/documents';
import type { EntitlementRepository } from '@aramo/entitlement';
import type { SignatureRoutingRepository, SignatureProviderKey } from '@aramo/signature-routing';
import type { AllowanceService } from '@aramo/subscription';
import type { Request, Response } from 'express';

import { ESignatureIntegrationService } from '../document-signing/esignature-integration.service.js';
import { SignatureAvailabilityService } from '../document-signing/signature-availability.service.js';
import { DocuSignWebhookController } from '../esignature-providers/docusign/docusign-webhook.controller.js';
import type { ExternalSignatureAdapter, ProviderConnectionState } from '../esignature-providers/external-signature-adapter.js';
import { ProviderCompletionService } from '../esignature-providers/provider-completion.service.js';
import type { ProviderCredentialStore } from '../esignature-providers/provider-credential-store.js';

// Multi-Provider directive §E/§F/§G — external providers end to end (provider HTTP faked):
// connection-driven availability, the OAuth connect flow, callback-driven completion
// that converges into Documents, and webhook spoofing / tenant-binding refusals.

const T = '0190eeee-0000-7000-8000-000000000001';

function fakeAdapter(state: ProviderConnectionState = 'CONNECTED'): ExternalSignatureAdapter & { [k: string]: ReturnType<typeof vi.fn> } {
  return {
    provider: 'docusign',
    connectionState: vi.fn(async () => state),
    authorizeUrl: vi.fn(({ state: s }: { state: string }) => `https://account-d.docusign.com/oauth/auth?state=${s}`),
    completeAuthorization: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    fetchCompletion: vi.fn(async () => ({ executed_pdf: Buffer.from('SIGNED'), evidence_pdf: Buffer.from('COC'), evidence_kind: 'DOCUSIGN_CERTIFICATE_OF_COMPLETION' })),
  } as never;
}

function routing(over: Partial<Record<string, unknown>> = {}) {
  return {
    getSelectedProvider: vi.fn(async () => ({ provider: 'docusign', explicit: true })),
    listSelectionEvents: vi.fn(async () => []),
    selectProvider: vi.fn(async () => ({ from: 'aramo_sign', to: 'docusign', changed: true })),
    createOAuthState: vi.fn(async () => ({ state: 'st-1' })),
    consumeOAuthState: vi.fn(async () => ({ code_verifier: 'ver-1' })),
    findRouteByEnvelope: vi.fn(async () => ({ tenant_id: T, document_id: 'doc-1', document_revision_id: 'rev-1' })),
    ...over,
  } as unknown as SignatureRoutingRepository;
}

function availabilityWith(adapter: ExternalSignatureAdapter, provider: SignatureProviderKey = 'docusign') {
  const r = routing({ getSelectedProvider: vi.fn(async () => ({ provider, explicit: true })) });
  const registry = new Map<SignatureProviderKey, never>([['aramo_sign', {} as never], ['docusign', adapter as never]]);
  return {
    availability: new SignatureAvailabilityService(r, { getCapabilities: async () => new Set(['ats']) } as unknown as EntitlementRepository, {} as AllowanceService, registry),
    registry,
    routing: r,
  };
}

describe('availability with an external provider', () => {
  it('a connected DocuSign is available — governed by the tenant’s own DocuSign plan, no Aramo allowance', async () => {
    const r = await availabilityWith(fakeAdapter('CONNECTED')).availability.evaluate(T, ['document:create', 'document:execute']);
    expect(r).toEqual({ provider: 'docusign', available: true, reason: null, allowance: null });
  });

  it.each(['NOT_CONNECTED', 'DEGRADED'] as const)('a %s DocuSign reads PROVIDER_DISCONNECTED (never a fallback to Aramo Sign)', async (state) => {
    expect(await availabilityWith(fakeAdapter(state)).availability.evaluate(T)).toMatchObject({ provider: 'docusign', available: false, reason: 'PROVIDER_DISCONNECTED' });
  });
});

describe('Settings → Integrations: connecting DocuSign', () => {
  function svc(adapter = fakeAdapter('NOT_CONNECTED')) {
    const { availability, registry, routing: r } = availabilityWith(adapter);
    return { s: new ESignatureIntegrationService(r, availability, registry), r, adapter };
  }

  it('lists DocuSign as connectable but not selectable until connected', async () => {
    const o = await svc().s.overview(T);
    expect(o.providers.find((p) => p.provider === 'docusign')).toMatchObject({ status: 'NOT_CONNECTED', selectable: false, connectable: true });
  });

  it('a degraded connection is flagged for reconnect', async () => {
    const o = await svc(fakeAdapter('DEGRADED')).s.overview(T);
    expect(o.providers.find((p) => p.provider === 'docusign')).toMatchObject({ needs_reconnect: true, selectable: false });
  });

  it('connect stores a single-use state for this admin and returns the provider sign-in URL', async () => {
    const { s, r } = svc();
    await expect(s.connect(T, 'docusign', 'admin-1', 'rq')).resolves.toEqual({ authorize_url: 'https://account-d.docusign.com/oauth/auth?state=st-1' });
    expect(r.createOAuthState).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, user_id: 'admin-1', provider: 'docusign', ttl_ms: 600000 }));
  });

  it('the callback consumes the state as this admin and completes the authorization with its verifier', async () => {
    const { s, r, adapter } = svc();
    await s.completeConnect({ tenant_id: T, provider: 'docusign', actor_id: 'admin-1', code: 'c', state: 'st-1', params: {}, requestId: 'rq' });
    expect(r.consumeOAuthState).toHaveBeenCalledWith({ state: 'st-1', tenant_id: T, user_id: 'admin-1', provider: 'docusign' });
    expect(adapter.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: T, code: 'c', code_verifier: 'ver-1' }));
  });

  it('a replayed, expired or foreign state is refused and nothing is connected', async () => {
    const { s, r, adapter } = svc();
    (r.consumeOAuthState as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    await expect(s.completeConnect({ tenant_id: T, provider: 'docusign', actor_id: 'admin-1', code: 'c', state: 'st-1', params: {}, requestId: 'rq' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', context: { details: { reason: 'OAUTH_STATE_INVALID' } } });
    expect(adapter.completeAuthorization).not.toHaveBeenCalled();
  });

  it('disconnect does not switch the tenant to another provider', async () => {
    const { s, r, adapter } = svc(fakeAdapter('CONNECTED'));
    await s.disconnect(T, 'docusign', 'admin-1', 'rq');
    expect(adapter.disconnect).toHaveBeenCalledWith(T);
    expect(r.selectProvider).not.toHaveBeenCalled();
  });

  it('a provider not configured in this environment cannot be connected', async () => {
    const { s } = svc();
    await expect(s.connect(T, 'adobe_sign', 'admin-1', 'rq')).rejects.toMatchObject({ statusCode: 422, context: { details: { reason: 'PROVIDER_UNAVAILABLE' } } });
  });
});

describe('ProviderCompletionService — callbacks are hints, not authority', () => {
  function make(opts: { route?: unknown; accountMatches?: boolean; completion?: unknown } = {}) {
    const adapter = fakeAdapter();
    if (opts.completion !== undefined) adapter.fetchCompletion.mockResolvedValue(opts.completion as never);
    const r = routing(opts.route === undefined ? {} : { findRouteByEnvelope: vi.fn(async () => opts.route) });
    const creds = { accountMatches: vi.fn(async () => opts.accountMatches ?? true) } as unknown as ProviderCredentialStore;
    const writeBack = { storeProviderExecuted: vi.fn(async () => ({ document_status: 'EXECUTED' })) } as unknown as DocumentExecutedWriteBackService;
    return { svc: new ProviderCompletionService(r, creds, writeBack, [adapter]), writeBack, adapter };
  }
  const input = { provider: 'docusign' as const, provider_account_id: 'acct-1', envelope_ref: 'env-1', requestId: 'rq' };

  it('a completed envelope converges into Documents (EXECUTED + provider evidence), keyed per envelope', async () => {
    const { svc, writeBack } = make();
    expect(await svc.handle(input)).toBe('PROCESSED');
    expect(writeBack.storeProviderExecuted).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: T, document_id: 'doc-1', revision_id: 'rev-1', provider: 'docusign', provider_envelope_ref: 'env-1',
      evidence_kind: 'DOCUSIGN_CERTIFICATE_OF_COMPLETION', idempotency_key: 'docusign-writeback:env-1',
    }));
  });

  it('an envelope this platform never routed is ignored', async () => {
    const { svc, writeBack } = make({ route: null });
    expect(await svc.handle(input)).toBe('IGNORED');
    expect(writeBack.storeProviderExecuted).not.toHaveBeenCalled();
  });

  it('a callback from a provider account the tenant did not connect is ignored (no cross-tenant write)', async () => {
    const { svc, writeBack, adapter } = make({ accountMatches: false });
    expect(await svc.handle(input)).toBe('IGNORED');
    expect(adapter.fetchCompletion).not.toHaveBeenCalled();
    expect(writeBack.storeProviderExecuted).not.toHaveBeenCalled();
  });

  it('a "completed" callback for an envelope the provider does not report completed writes nothing', async () => {
    const { svc, writeBack } = make({ completion: null });
    expect(await svc.handle(input)).toBe('IGNORED');
    expect(writeBack.storeProviderExecuted).not.toHaveBeenCalled();
  });
});

describe('DocuSign Connect webhook endpoint', () => {
  const body = Buffer.from(JSON.stringify({ event: 'envelope-completed', data: { accountId: 'acct-1', envelopeId: 'env-1' } }));
  const sign = (b: Buffer, key = 'hmac-key') => createHmac('sha256', key).update(b).digest('base64');
  const CONFIG = { integrationKey: 'i', clientSecret: 's', oauthBaseUrl: 'o', redirectUri: 'r', connectHmacKey: 'hmac-key' };

  async function call(opts: { config?: typeof CONFIG | null; headers?: Record<string, string>; raw?: Buffer; handle?: () => Promise<string> }) {
    const completion = { handle: vi.fn(opts.handle ?? (async () => 'PROCESSED')) } as unknown as ProviderCompletionService;
    const ctl = new DocuSignWebhookController(completion, opts.config === undefined ? CONFIG : opts.config);
    let status = 0;
    const res = { status: (s: number) => { status = s; return res; } } as unknown as Response;
    await ctl.docusign({ body: opts.raw ?? body, headers: opts.headers ?? {} } as unknown as Request, res);
    return { status, completion };
  }

  it('503 when DocuSign is not configured in this environment', async () => {
    expect((await call({ config: null })).status).toBe(503);
  });
  it('401 for a missing or forged signature, before anything is read', async () => {
    const r = await call({ headers: { 'x-docusign-signature-1': sign(body, 'attacker') } });
    expect(r.status).toBe(401);
    expect(r.completion.handle).not.toHaveBeenCalled();
  });
  it('204 and completion handling for a signed envelope-completed event', async () => {
    const r = await call({ headers: { 'x-docusign-signature-1': sign(body) } });
    expect(r.status).toBe(204);
    expect(r.completion.handle).toHaveBeenCalledWith(expect.objectContaining({ provider: 'docusign', provider_account_id: 'acct-1', envelope_ref: 'env-1' }));
  });
  it('204 without action for other events', async () => {
    const other = Buffer.from(JSON.stringify({ event: 'envelope-sent', data: { accountId: 'a', envelopeId: 'e' } }));
    const r = await call({ raw: other, headers: { 'x-docusign-signature-1': sign(other) } });
    expect(r.status).toBe(204);
    expect(r.completion.handle).not.toHaveBeenCalled();
  });
  it('400 for a signed but malformed body; 500 (DocuSign retries) when storing fails', async () => {
    const bad = Buffer.from('nope');
    expect((await call({ raw: bad, headers: { 'x-docusign-signature-1': sign(bad) } })).status).toBe(400);
    expect((await call({ headers: { 'x-docusign-signature-1': sign(body) }, handle: async () => { throw new Error('s3 down'); } })).status).toBe(500);
  });
});
