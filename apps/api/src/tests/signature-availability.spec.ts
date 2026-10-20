import { describe, expect, it, vi } from 'vitest';
import type { SignatureProviderPort } from '@aramo/documents-contracts';
import type { EntitlementRepository } from '@aramo/entitlement';
import type { SignatureRoutingRepository, SignatureProviderKey } from '@aramo/signature-routing';
import type { AllowanceService } from '@aramo/subscription';

import { SignatureAvailabilityService } from '../document-signing/signature-availability.service.js';
import { SignatureRoutingService } from '../document-signing/signature-routing.service.js';

// Multi-Provider directive §D — ONE backend decision for "can this tenant send a
// document for signature now, and through which provider", with typed reasons.

const PERIOD_END = new Date('2026-11-01T00:00:00.000Z');
const status = (used: number, limit = 100) => ({ subscribed: true as const, plan_key: 'p', allowance_key: 'sign.envelopes', limit, used, remaining: Math.max(0, limit - used), period_start: new Date('2026-10-01T00:00:00Z'), period_end: PERIOD_END, threshold: used >= limit ? 'EXHAUSTED' : used >= 80 ? 'WARNING' : 'OK' });

function make(opts: { provider?: SignatureProviderKey; caps?: string[]; allowance?: unknown; registry?: SignatureProviderKey[] } = {}) {
  const routing = {
    getSelectedProvider: vi.fn(async () => ({ provider: opts.provider ?? 'aramo_sign', explicit: opts.provider !== undefined })),
    findRoute: vi.fn(async () => null),
    recordRoute: vi.fn(async () => undefined),
  } as unknown as SignatureRoutingRepository;
  const entitlements = { getCapabilities: vi.fn(async () => new Set(opts.caps ?? ['core', 'ats', 'sign'])) } as unknown as EntitlementRepository;
  const allowance = { getStatus: vi.fn(async () => opts.allowance ?? status(3)) } as unknown as AllowanceService;
  const port = { name: 'aramo' } as unknown as SignatureProviderPort;
  const registry = new Map<SignatureProviderKey, SignatureProviderPort>((opts.registry ?? ['aramo_sign']).map((k) => [k, port]));
  const availability = new SignatureAvailabilityService(routing, entitlements, allowance, registry);
  return { availability, router: new SignatureRoutingService(availability, routing, registry), routing, port };
}

const SENDER = ['document:create', 'document:execute'];

describe('SignatureAvailabilityService', () => {
  it('Aramo Sign with a subscription and allowance left is available, with the allowance', async () => {
    const r = await make().availability.evaluate('t1', SENDER);
    expect(r).toMatchObject({ provider: 'aramo_sign', available: true, reason: null, allowance: { limit: 100, used: 3, remaining: 97, threshold: 'OK', period_end: PERIOD_END.toISOString() } });
  });

  it.each([
    ['NOT_AUTHORIZED', { }, ['document:create']],
    ['NOT_SUBSCRIBED', { caps: ['core', 'ats'] }, SENDER],
    ['NOT_SUBSCRIBED', { allowance: { subscribed: false, allowance_key: 'sign.envelopes' } }, SENDER],
    ['LIMIT_REACHED', { allowance: status(100) }, SENDER],
    ['PROVIDER_UNAVAILABLE', { provider: 'docusign' as const }, SENDER],
  ])('%s', async (reason, opts, scopes) => {
    const r = await make(opts).availability.evaluate('t1', scopes);
    expect(r).toMatchObject({ available: false, reason });
  });

  it('without actor scopes it judges the tenant only (policy authoring)', async () => {
    expect(await make().availability.evaluate('t1')).toMatchObject({ available: true });
  });

  it('a limit reached keeps the allowance so the UI can show the renewal date', async () => {
    const r = await make({ allowance: status(100) }).availability.evaluate('t1', SENDER);
    expect(r.allowance).toMatchObject({ remaining: 0, threshold: 'EXHAUSTED', period_end: PERIOD_END.toISOString() });
  });
});

describe('SignatureRoutingService', () => {
  it('a new send asserts availability and routes to the selected provider', async () => {
    const { router, port } = make();
    await expect(router.forNewSend('t1', 'req-1')).resolves.toEqual({ provider: 'aramo_sign', port });
  });

  it('a new send that is not available is refused with ESIGN_SEND_UNAVAILABLE and the reason', async () => {
    const { router } = make({ allowance: status(100) });
    await expect(router.forNewSend('t1', 'req-1')).rejects.toMatchObject({
      code: 'ESIGN_SEND_UNAVAILABLE',
      statusCode: 409,
      context: { details: { reason: 'LIMIT_REACHED', provider: 'aramo_sign' } },
    });
  });

  it('an existing request routes by its frozen provider, not today\'s selection', async () => {
    const { router, routing, port } = make({ provider: 'docusign', registry: ['aramo_sign', 'docusign'] });
    (routing.findRoute as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ provider: 'aramo_sign', provider_envelope_ref: 'E1', created_at: new Date() });
    await expect(router.forDocument('t1', 'doc', 'rev')).resolves.toEqual({ provider: 'aramo_sign', port });
  });

  it('a request created before routing existed is Aramo Sign', async () => {
    const { router, port } = make({ provider: 'docusign', registry: ['aramo_sign', 'docusign'] });
    await expect(router.forDocument('t1', 'doc', 'rev')).resolves.toEqual({ provider: 'aramo_sign', port });
  });
});
