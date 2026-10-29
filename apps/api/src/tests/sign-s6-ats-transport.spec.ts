import { inspect } from 'node:util';

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import { signatureActor, type EnvelopeSummary, type SignatureProviderPort } from '@aramo/documents-contracts';
import type { DocumentsRepository, RenderService } from '@aramo/documents';

import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import type { SignatureRouter } from '../document-signing/signature-router.js';
import { EsignServiceApiProvider, assertSignAtsTransport } from '../sign/esign-service-api.provider.js';
import { SignApiClient } from '../sign/sign-api.client.js';
import { EsignExecutedArtifactsClient } from '../documents/esign-writeback.js';
import { EsignEventsController } from '../integrations/sign/esign-events.controller.js';
import { computeEsignWebhookSignature } from '../integrations/sign/esign-webhook-signature.js';
import { SignatureAvailabilityService } from '../document-signing/signature-availability.service.js';


// Aramo-Sign-Unified-Product-S6-ATS-Migration-Addendum-v1_0-LOCKED — the ATS as a
// client of the Sign API: typed actor credential (redacted, Aramo-Sign-only), the
// API transport (feature-gated, default internal), the event-bound completion pull.

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.recruiter-session.signature';
const env = (over: Partial<EnvelopeSummary> = {}): EnvelopeSummary => ({ envelope_id: 'E1', status: 'SENT', signers: [], ...over });

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(['SIGN_ATS_TRANSPORT', 'SIGN_ATS_CLIENT_ID', 'SIGN_ATS_CLIENT_SECRET', 'SIGN_SERVICE_URL'].map((k) => [k, process.env[k]]));
  process.env['SIGN_ATS_CLIENT_ID'] = 'sgc_ats';
  process.env['SIGN_ATS_CLIENT_SECRET'] = 'sgs_ats_secret';
  process.env['SIGN_SERVICE_URL'] = 'http://esign.test';
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('typed actor credential — never serialized or inspected', () => {
  it('keeps the bearer out of JSON, inspection and enumeration', () => {
    const a = signatureActor(TOKEN);
    expect(a.access_token).toBe(TOKEN);
    expect(JSON.stringify({ a })).not.toContain(TOKEN);
    expect(inspect(a)).not.toContain(TOKEN);
    expect(Object.keys(a)).toEqual(['kind']);
  });
});

// Aramo-Sign-Domain-Isolation-Reconciliation-V1 §3 H-2 — the internal transport is retired.
describe('transport: the authenticated Sign API only', () => {
  it('accepts an unset or `api` value and refuses anything else (no silent internal fallback)', () => {
    expect(() => assertSignAtsTransport({})).not.toThrow();
    expect(() => assertSignAtsTransport({ SIGN_ATS_TRANSPORT: '' })).not.toThrow();
    expect(() => assertSignAtsTransport({ SIGN_ATS_TRANSPORT: 'api' })).not.toThrow();
    expect(() => assertSignAtsTransport({ SIGN_ATS_TRANSPORT: 'internal' })).toThrow(/retired/);
    expect(() => assertSignAtsTransport({ SIGN_ATS_TRANSPORT: 'API' })).toThrow(/retired/);
  });
});

describe('the actor reaches ONLY the Aramo Sign provider', () => {
  function make(provider: 'aramo_sign' | 'docusign') {
    const port = {
      findEnvelopeForDocument: vi.fn(async () => null),
      createEnvelope: vi.fn(async () => env({ envelope_id: 'E-new', status: 'DRAFT' })),
      sendEnvelope: vi.fn(async () => env({ envelope_id: 'E-new', status: 'SENT' })),
    } as unknown as SignatureProviderPort;
    const router: SignatureRouter = {
      forNewSend: vi.fn(async () => ({ provider, port })),
      forDocument: vi.fn(async () => ({ provider, port })),
      recordRoute: vi.fn(async () => undefined),
      recordAccepted: vi.fn(async () => undefined),
    };
    const documents = { getCurrentRevision: vi.fn(async () => ({ id: 'rev-1', content_sha256: 'AAA', render_manifest: { signature_fields: [{ field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 150, height: 30 }, { field_type: 'SIGNER_NAME', page_number: 0, x: 240, y: 100, width: 150, height: 30 }, { field_type: 'SIGN_DATE', page_number: 0, x: 408, y: 100, width: 120, height: 30 }] } })), prepareDocument: vi.fn(async () => undefined) } as unknown as DocumentsRepository;
    const svc = new GovernedDocumentSigningService(documents, {} as RenderService, router);
    return { svc, port, router };
  }
  const input = { tenant_id: 't1', document_id: 'doc-1', subject: 'RTR', execution_mode: 'SINGLE_SIGNATURE', recipient: { email: 'a@b.test', name: 'A' }, created_by: 'u1', requestId: 'r1' };

  it('Aramo Sign: create and send carry the recruiter credential', async () => {
    const actor = signatureActor(TOKEN);
    const { svc, port, router } = make('aramo_sign');
    await svc.send({ ...input, actor });
    expect(router.forNewSend).toHaveBeenCalledWith('t1', 'r1', actor);
    expect((port.createEnvelope as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1]).toBe(actor);
    expect((port.sendEnvelope as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![3]).toBe(actor);
  });

  it('DocuSign / Adobe never receive it', async () => {
    const { svc, port } = make('docusign');
    await svc.send({ ...input, actor: signatureActor(TOKEN) });
    for (const fn of [port.findEnvelopeForDocument, port.createEnvelope, port.sendEnvelope]) {
      for (const call of (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls) {
        expect(JSON.stringify(call)).not.toContain(TOKEN);
        expect(call.some((a) => typeof a === 'object' && a !== null && (a as { kind?: unknown }).kind === 'aramo-user')).toBe(false);
      }
    }
  });
});

function tokenResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('API transport provider (user-initiated)', () => {
  it('fails closed without the recruiter (never the internal path)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const p = new EsignServiceApiProvider(new SignApiClient());
    await expect(p.sendEnvelope('t1', 'E1')).rejects.toMatchObject({ code: 'ESIGN_SEND_UNAVAILABLE', context: { details: { reason: 'actor_required' } } });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exchanges the recruiter token, then calls the Sign API without any caller-supplied tenant authority', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/v1/sign/oauth/token')) return tokenResponse({ access_token: 'sgt_user_grant_000000000000000000000', expires_in: 300, tenant_id: 't1', installation_id: 'i1' });
        return tokenResponse(env({ envelope_id: 'E-new', status: 'DRAFT' }), 201);
      }),
    );
    const p = new EsignServiceApiProvider(new SignApiClient());
    await p.createEnvelope(
      { tenant_id: 't1', subject: 'RTR', execution_mode: 'SINGLE_SIGNATURE', created_by: 'u1', documents: [{ document_ref: 'd', document_revision_ref: 'r', title: 'RTR', source_sha256: 'x', ordinal: 1 }], signers: [{ email: 'a@b.test', name: 'A', signing_order: 1 }] },
      signatureActor(TOKEN),
    );
    const exchange = JSON.parse(String(calls[0]!.init.body)) as Record<string, string>;
    expect(exchange).toMatchObject({ grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: TOKEN, client_id: 'sgc_ats' });
    expect(calls[1]!.url).toBe('http://esign.test/v1/sign/api/envelopes');
    expect((calls[1]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer sgt_user_grant_000000000000000000000');
    const body = JSON.parse(String(calls[1]!.init.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tenant_id');
    expect(body).not.toHaveProperty('created_by');
  });

  it('refuses a delegation for a different organization; never logs a credential', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn');
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({ access_token: 'sgt_x', expires_in: 300, tenant_id: 'OTHER', installation_id: 'i1' })));
    const c = new SignApiClient();
    await expect(c.userGrant(signatureActor(TOKEN), 't1')).rejects.toMatchObject({ context: { details: { reason: 'tenant_mismatch' } } });
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({ error: { code: 'INSUFFICIENT_PERMISSIONS', details: { reason: 'no_authority' } } }, 403)));
    await expect(new SignApiClient().userGrant(signatureActor(TOKEN), 't1')).rejects.toBeInstanceOf(AramoError);
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(TOKEN);
      expect(JSON.stringify(call)).not.toContain('sgs_ats_secret');
    }
  });

  it('caches a grant per recruiter token (by digest) until shortly before expiry', async () => {
    const f = vi.fn(async () => tokenResponse({ access_token: 'sgt_cached', expires_in: 300, tenant_id: 't1', installation_id: 'i1' }));
    vi.stubGlobal('fetch', f);
    const c = new SignApiClient();
    await c.userGrant(signatureActor(TOKEN), 't1');
    await c.userGrant(signatureActor(TOKEN), 't1');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('completion write-back (no user): the event-bound grant', () => {
  it('API transport: needs the delivered event; presents it with the ATS client credential; refuses a mismatched scope', async () => {
    process.env['SIGN_ATS_TRANSPORT'] = 'api';
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/oauth/token')) return tokenResponse({ access_token: 'sgt_event', expires_in: 300, tenant_id: 't1', installation_id: 'i1', envelope_id: 'E1' });
        return tokenResponse({ envelope_id: 'E1', documents: [], certificate: null });
      }),
    );
    const client = new EsignExecutedArtifactsClient(new SignApiClient());
    await expect(client.fetchExecuted('t1', 'E1')).rejects.toThrow(/completion event/);
    await client.fetchExecuted('t1', 'E1', '66666666-6666-7666-8666-666666666666');
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ grant_type: 'urn:aramo:params:oauth:grant-type:sign-event', event_id: '66666666-6666-7666-8666-666666666666', client_id: 'sgc_ats' });
    expect(calls[1]!.url).toBe('http://esign.test/v1/sign/api/envelopes/E1/executed');
    await expect(new EsignExecutedArtifactsClient(new SignApiClient()).fetchExecuted('t1', 'OTHER', '77777777-7777-7777-8777-777777777777')).rejects.toThrow(/scope mismatch/);
  });

  it('without the delivered event the pull is refused and nothing is fetched (no internal fallback)', async () => {
    delete process.env['SIGN_ATS_TRANSPORT'];
    const f = vi.fn(async () => tokenResponse({ envelope_id: 'E1', documents: [], certificate: null }));
    vi.stubGlobal('fetch', f);
    await expect(new EsignExecutedArtifactsClient(new SignApiClient()).fetchExecuted('t1', 'E1')).rejects.toThrow(/completion event/);
    expect(f).not.toHaveBeenCalled();
  });
});

// ── Completion webhook: the ATS subscription's OWN secret (S-5/S6) ─────────────

describe('completion webhook verification', () => {
  const body = Buffer.from(JSON.stringify({ event_id: 'ev-1', event_type: 'sign.envelope.executed.v1', tenant_id: 't1', envelope_id: 'E1' }));
  function call(headers: Record<string, string>) {
    const orchestrator = { writeBackEnvelope: vi.fn(async () => ({ envelope_id: 'E1', documents_written: 1 })) };
    const ctl = new EsignEventsController(orchestrator as never);
    const res = { statusCode: 0, status(c: number) { this.statusCode = c; return this; } };
    const req = { body, headers };
    return { run: () => ctl.events(req as never, res as never, 'r'), res, orchestrator };
  }
  const signed = (secret: string, extra: Record<string, string> = {}) => {
    const ts = String(Math.floor(Date.now() / 1000));
    return { 'x-aramo-sign-timestamp': ts, 'x-aramo-sign-signature': computeEsignWebhookSignature(ts, body, secret), ...extra };
  };
  let keep: Record<string, string | undefined> = {};
  beforeEach(() => {
    keep = { a: process.env['SIGN_WEBHOOK_SIGNING_SECRET'], b: process.env['SIGN_EVENTS_SUBSCRIPTION_SECRET'] };
    process.env['SIGN_WEBHOOK_SIGNING_SECRET'] = 'legacy-shared';
    process.env['SIGN_EVENTS_SUBSCRIPTION_SECRET'] = 'whs_ats_subscription';
  });
  afterEach(() => {
    for (const [k, v] of [['SIGN_WEBHOOK_SIGNING_SECRET', keep['a']], ['SIGN_EVENTS_SUBSCRIPTION_SECRET', keep['b']]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a subscription delivery verifies with the subscription secret and passes the event to the write-back', async () => {
    const c = call(signed('whs_ats_subscription', { 'x-aramo-sign-subscription-id': 'sub-1' }));
    await c.run();
    expect(c.res.statusCode).toBe(200);
    expect(c.orchestrator.writeBackEnvelope).toHaveBeenCalledWith(expect.objectContaining({ event_id: 'ev-1', tenant_id: 't1', envelope_id: 'E1' }));
  });

  it('a subscription delivery signed with the legacy shared secret is spoofed → 401', async () => {
    const c = call(signed('legacy-shared', { 'x-aramo-sign-subscription-id': 'sub-1' }));
    await c.run();
    expect(c.res.statusCode).toBe(401);
    expect(c.orchestrator.writeBackEnvelope).not.toHaveBeenCalled();
  });

  it('a legacy delivery still verifies with the legacy secret (internal fallback)', async () => {
    const c = call(signed('legacy-shared'));
    await c.run();
    expect(c.res.statusCode).toBe(200);
  });

  it('a subscription delivery with no subscription secret configured is refused (fail closed)', async () => {
    delete process.env['SIGN_EVENTS_SUBSCRIPTION_SECRET'];
    const c = call(signed('whs_ats_subscription', { 'x-aramo-sign-subscription-id': 'sub-1' }));
    await c.run();
    expect(c.res.statusCode).toBe(503);
  });
});

describe('availability over the API transport (D-12)', () => {
  function svc(port: unknown) {
    const allowance = { getStatus: vi.fn() };
    const s = new SignatureAvailabilityService(
      { getSelectedProvider: vi.fn(async () => ({ provider: 'aramo_sign' })) } as never,
      { getCapabilities: vi.fn(async () => new Set(['ats', 'sign'])) } as never,
      allowance as never,
      new Map([['aramo_sign', port]]) as never,
    );
    return { s, allowance };
  }
  it('asks Sign with the recruiter’s delegation; never reads Sign’s subscription library', async () => {
    const api = new EsignServiceApiProvider(new SignApiClient());
    vi.spyOn(api, 'availability').mockResolvedValue({ available: false, reason: 'LIMIT_REACHED', allowance: { limit: 100, unlimited: false, used: 100, remaining: 0, period_start: 'a', period_end: 'b', threshold: 'EXHAUSTED' } });
    const { s, allowance } = svc(api);
    await expect(s.evaluate('t1', ['document:create', 'document:execute'], signatureActor(TOKEN))).resolves.toMatchObject({ available: false, reason: 'LIMIT_REACHED', allowance: { used: 100 } });
    // A tenant-level read (no recruiter): entitlement only; Sign decides at send time.
    await expect(s.evaluate('t1')).resolves.toMatchObject({ available: true, allowance: null });
    expect(allowance.getStatus).not.toHaveBeenCalled();
  });
});
