import type { AuthContextType } from '@aramo/auth';
import type { IdentityRepository } from '@aramo/identity';
import { BillingRefusedError, SeatChangeRefusedError, type SeatBillingService, StripeBillingProvider, type SubscriptionLifecycleService } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { EsignBillingReconcileWorker } from '../app/billing/esign-billing-reconcile.worker.js';
import { EsignBillingController, billingHttpError } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// Aramo Sign Monthly and Annual-Commitment Pricing Directive v1.0 (LOCKED 2026-11-15) §3.3, §3.5, §3.6 — the
// sign-service billing surface: checkout takes an optional `term` (validated; passed to the lifecycle; a term
// the plan does not sell → 422 term_not_available), and the reconcile sweep runs the post-commitment move to
// the MONTHLY price (Q2). (Harness shared with sign-business-per-seat.spec.ts.)

const auth = (sub = 'u-owner'): AuthContextType => ({ sub, tenant_id: 't-1', scopes: ['sign:billing:manage', 'sign:envelope:read'], consumer_type: 'sign' }) as unknown as AuthContextType;

function setup(o: { roleKeys?: string[]; seatState?: unknown; priceUnit?: 'ACCOUNT' | 'SEAT' | null; used?: number; kind?: string; seats?: Partial<SeatBillingService> } = {}) {
  const lifecycle = {
    account: vi.fn(async () => ({ subscription: null, allowance: { subscribed: false }, billing_available: true, tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' }, price_unit: o.priceUnit === undefined ? 'SEAT' : o.priceUnit })),
    sendingOwner: vi.fn(async () => null),
    tenantActivationState: vi.fn(async () => null),
    startCheckout: vi.fn(async () => ({ url: 'https://checkout.stripe.test/x' })),
  } as unknown as SubscriptionLifecycleService;
  const ctx = {
    tenantKind: vi.fn(async () => o.kind ?? 'BUSINESS'),
    tenantOf: vi.fn(async () => ({ id: 't-1', kind: o.kind ?? 'BUSINESS', status: 'ACTIVE' })),
    personalAuthoringOpen: vi.fn(() => false),
    assertBusiness: vi.fn(async () => undefined),
    assertCanAuthorTenant: vi.fn(async () => ({ id: 't-1', kind: 'BUSINESS', status: 'ACTIVE' })),
  } as unknown as SenderContextService;
  const identity = {
    findUserById: vi.fn(async () => ({ id: 'u-owner', email: 'owner@acme.test' })),
    findMembership: vi.fn(async () => ({ id: 'm-1', is_active: true })),
    findRoleKeysForMembership: vi.fn(async () => o.roleKeys ?? ['tenant_owner']),
    countSignSeats: vi.fn(async () => o.used ?? 3),
  } as unknown as IdentityRepository;
  const seats = {
    seatState: vi.fn(async () => (o.seatState === undefined ? { price_unit: 'SEAT', purchased: 5, pending_purchased: null, changeable: true } : o.seatState)),
    changeSeats: vi.fn(async (i: { seats: number; used: number }) => ({ purchased: i.seats, used: i.used, pending_purchased: null, effective: 'NOW' })),
    ...o.seats,
  } as unknown as SeatBillingService;
  const owners = { activate: vi.fn() } as unknown as EsignOwnerActivationService;
  const controller = new EsignBillingController(lifecycle, new StripeBillingProvider(), owners, ctx, identity, undefined, undefined, undefined, undefined, undefined, undefined, seats);
  return { controller, lifecycle, identity, seats };
}

const failure = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code: string; statusCode: number; context?: { details?: Record<string, unknown> } }) => `${e.statusCode} ${e.code} ${String(e.context?.details?.['reason'] ?? '')}`.trim());

describe('checkout term (§3.3)', () => {
  it('passes MONTHLY / ANNUAL_COMMIT to the lifecycle; omits it when absent (the default term); refuses anything else 400 term_invalid', async () => {
    const { controller, lifecycle } = setup();
    await controller.checkout(auth(), 'r', { plan_key: 'aramo-sign-standard-business-v1', term: 'ANNUAL_COMMIT' });
    expect(lifecycle.startCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ term: 'ANNUAL_COMMIT' }));
    await controller.checkout(auth(), 'r', { plan_key: 'aramo-sign-standard-business-v1', term: 'MONTHLY' });
    expect(lifecycle.startCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ term: 'MONTHLY' }));
    await controller.checkout(auth(), 'r', { plan_key: 'aramo-sign-standard-business-v1' });
    expect(lifecycle.startCheckout).toHaveBeenLastCalledWith(expect.not.objectContaining({ term: expect.anything() }));
    const calls = (lifecycle.startCheckout as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    for (const term of ['YEARLY', 'monthly', 12, null]) expect(await failure(controller.checkout(auth(), 'r', { plan_key: 'p', term }))).toBe('400 VALIDATION_ERROR term_invalid');
    expect((lifecycle.startCheckout as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
  });

  it('a term the plan does not sell maps to 422 term_not_available', () => {
    const e = billingHttpError(new BillingRefusedError('TERM_NOT_AVAILABLE'), 'r');
    expect([e.statusCode, e.code, e.context.details?.['reason']]).toEqual([422, 'VALIDATION_ERROR', 'term_not_available']);
  });
});

describe('reconcile sweep — the post-commitment MONTHLY price (Q2)', () => {
  it('runs the term rollover after the re-fetch; without the service bound the sweep is unchanged', async () => {
    const lifecycle = {
      reconcile: vi.fn(async () => ({ checked: 1, applied: 1, failed: 0, results: [] })),
      refreshEligibility: vi.fn(async () => ({ checked: 0, lapsed: 0, restored: 0 })),
    } as unknown as SubscriptionLifecycleService;
    const owners = { activate: vi.fn() } as unknown as EsignOwnerActivationService;
    const rollover = { run: vi.fn(async () => ({ due: 1, moved: 1, skipped: 0, failed: 0 })) };
    expect(await new EsignBillingReconcileWorker(lifecycle, owners, rollover as never).tick(new Date('2027-11-01T00:00:00Z'))).toBe(1);
    expect(rollover.run).toHaveBeenCalledWith('sign', new Date('2027-11-01T00:00:00Z'));
    expect(await new EsignBillingReconcileWorker(lifecycle, owners).tick()).toBe(1);
  });
});
