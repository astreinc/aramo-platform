import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { SignatureProviderPort } from '@aramo/documents-contracts';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import type { SignatureRoutingRepository, SignatureProviderKey } from '@aramo/signature-routing';

import { ESignatureIntegrationController } from '../document-signing/esignature-integration.controller.js';
import { ESignatureIntegrationService } from '../document-signing/esignature-integration.service.js';
import type { SignatureAvailabilityService } from '../document-signing/signature-availability.service.js';

// Multi-Provider directive §E — Settings → Integrations → E-Signature: one active
// provider per tenant, explicit + audited + backend-validated, admin-only, and
// never claiming an external provider works before its integration exists.

function make(opts: { selected?: SignatureProviderKey; registry?: SignatureProviderKey[] } = {}) {
  let selected: SignatureProviderKey = opts.selected ?? 'aramo_sign';
  const routing = {
    getSelectedProvider: vi.fn(async () => ({ provider: selected, explicit: true })),
    selectProvider: vi.fn(async ({ provider }: { provider: SignatureProviderKey }) => {
      const from = selected;
      selected = provider;
      return { from, to: provider, changed: from !== provider };
    }),
    listSelectionEvents: vi.fn(async () => [{ from_provider: 'aramo_sign', to_provider: 'aramo_sign', actor_id: 'u1', occurred_at: new Date('2026-10-18T00:00:00Z') }]),
  } as unknown as SignatureRoutingRepository;
  const availability = {
    evaluate: vi.fn(async () => ({ provider: selected, available: true, reason: null, allowance: { limit: 100, used: 82, remaining: 18, period_start: 'a', period_end: '2026-11-01T00:00:00.000Z', threshold: 'WARNING' } })),
  } as unknown as SignatureAvailabilityService;
  const registry = new Map<SignatureProviderKey, SignatureProviderPort>((opts.registry ?? ['aramo_sign']).map((k) => [k, {} as SignatureProviderPort]));
  return { svc: new ESignatureIntegrationService(routing, availability, registry), routing };
}

describe('ESignatureIntegrationService', () => {
  it('the overview lists all three providers, the active one, the allowance and recent changes', async () => {
    const o = await make().svc.overview('t1');
    expect(o.active_provider).toBe('aramo_sign');
    expect(o.providers.map((p) => [p.provider, p.status, p.selectable])).toEqual([
      ['aramo_sign', 'BUILT_IN', true],
      ['docusign', 'NOT_AVAILABLE', false],
      ['adobe_sign', 'NOT_AVAILABLE', false],
    ]);
    expect(o.availability).toMatchObject({ available: true, allowance: { used: 82, threshold: 'WARNING' } });
    expect(o.recent_changes).toHaveLength(1);
  });

  it('selecting a provider is recorded with the actor', async () => {
    const { svc, routing } = make({ selected: 'aramo_sign' });
    await svc.select('t1', 'aramo_sign', 'admin-1', 'r1');
    expect(routing.selectProvider).toHaveBeenCalledWith({ tenant_id: 't1', provider: 'aramo_sign', actor_id: 'admin-1' });
  });

  it('a provider without a working integration cannot be selected', async () => {
    const { svc, routing } = make();
    await expect(svc.select('t1', 'docusign', 'admin-1', 'r1')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
      context: { details: { reason: 'PROVIDER_UNAVAILABLE', provider: 'docusign' } },
    });
    expect(routing.selectProvider).not.toHaveBeenCalled();
  });

  it('an unknown provider is a validation error', async () => {
    await expect(make().svc.select('t1', 'acme' as never, 'admin-1', 'r1')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
  });
});

describe('ESignatureIntegrationController — admin-only writes', () => {
  it('reads need integration:read, the provider change needs integration:write', () => {
    const proto = ESignatureIntegrationController.prototype;
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto.overview)).toEqual(['integration:read']);
    expect(Reflect.getMetadata(REQUIRED_SCOPES_KEY, proto.selectActive)).toEqual(['integration:write']);
  });
});
