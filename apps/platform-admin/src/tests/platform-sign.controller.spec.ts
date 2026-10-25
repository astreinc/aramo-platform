import type { AuthContextType } from '@aramo/auth';
import type { EntitlementRepository } from '@aramo/entitlement';
import type { TenantService } from '@aramo/identity';
import type { SubscriptionLifecycleService } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { PlatformSignController } from '../app/platform/platform-sign.controller.js';

// Aramo Sign launch — the operator's read-only Sign account view: platform tier
// only, 404 for an unknown tenant, and a composed read (capabilities +
// subscription + usage + recent billing events) with no mutation.

const T = '019a0000-0000-7000-8000-0000000000aa';
const auth = (consumer_type: string) => ({ sub: 'op', tenant_id: 'sentinel', scopes: ['platform:tenant:read'], consumer_type }) as unknown as AuthContextType;

function build(tenant: unknown = { id: T, kind: 'BUSINESS' }) {
  const lifecycle = {
    account: vi.fn(async () => ({ subscription: { plan_key: 'aramo-sign-business-v1', status: 'ACTIVE' }, allowance: { subscribed: true, used: 3, limit: 100 }, billing_available: true })),
    recentBillingEvents: vi.fn(async () => [{ event_type: 'invoice.paid', outcome: 'APPLIED', detail: null, event_created_at: new Date(0), received_at: new Date(0) }]),
  } as unknown as SubscriptionLifecycleService;
  const c = new PlatformSignController(
    { getTenantById: vi.fn(async () => tenant) } as unknown as TenantService,
    { getCapabilities: vi.fn(async () => new Set(['sign', 'core'])) } as unknown as EntitlementRepository,
    lifecycle,
  );
  return { c, lifecycle };
}

describe('PlatformSignController', () => {
  it('composes capabilities, subscription, usage and recent billing events', async () => {
    const { c, lifecycle } = build();
    const res = await c.sign(T, auth('platform'), 'r');
    expect(res).toMatchObject({ tenant_id: T, tenant_kind: 'BUSINESS', capabilities: ['core', 'sign'], sign_entitled: true, allowance: { used: 3, limit: 100 } });
    expect(res.billing_events).toHaveLength(1);
    expect(lifecycle.account).toHaveBeenCalledWith(T, 'sign', 'sign.envelopes');
  });

  it('refuses a non-platform token and 404s an unknown tenant', async () => {
    await expect(build().c.sign(T, auth('sign'), 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS', statusCode: 403 });
    await expect(build(null).c.sign(T, auth('platform'), 'r')).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
  });
});
