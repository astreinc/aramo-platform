import type { AuthContextType } from '@aramo/auth';
import type { IdentityRepository } from '@aramo/identity';
import { BillingRefusedError, SeatChangeRefusedError, type SeatBillingService, StripeBillingProvider, type SubscriptionLifecycleService } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { EsignBillingController, billingHttpError } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.3 — the sign-service
// billing surface: POST seats (owner / admin only, O-3; increase now, decrease at period end; below usage,
// non-SEAT and unchanged refused 409), GET account (price_unit, seats, can_manage_seats), checkout seats
// (validated, passed to the lifecycle; 422 seats_not_applicable for a per-account plan).

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

describe('POST /v1/sign/billing/seats (§3.3.3)', () => {
  it('the owner or an admin changes the seats; the S-4 count is passed as `used`', async () => {
    for (const roleKeys of [['tenant_owner'], ['tenant_admin']]) {
      const { controller, seats } = setup({ roleKeys, used: 3 });
      expect(await controller.changeSeats(auth(), 'r', { seats: 7 })).toEqual({ purchased: 7, used: 3, pending_purchased: null, effective: 'NOW' });
      expect(seats.changeSeats).toHaveBeenCalledWith({ tenant_id: 't-1', product_key: 'sign', seats: 7, used: 3 });
    }
  });

  it('a non-admin (Sign admin, sender) is refused 403 before any change', async () => {
    for (const roleKeys of [['sign_admin'], ['sign_sender']]) {
      const { controller, seats } = setup({ roleKeys });
      expect(await failure(controller.changeSeats(auth(), 'r', { seats: 7 }))).toBe('403 INSUFFICIENT_PERMISSIONS seat_manage_role_required');
      expect(seats.changeSeats).not.toHaveBeenCalled();
    }
  });

  it('refusals: below usage, not per seat (incl. store / contract), unchanged → 409; a bad count → 400', async () => {
    const refuse = (e: SeatChangeRefusedError) => setup({ seats: { changeSeats: vi.fn(async () => { throw e; }) } as never });
    expect(await failure(refuse(new SeatChangeRefusedError('seats_below_usage', { used: 4 })).controller.changeSeats(auth(), 'r', { seats: 2 }))).toBe('409 ESIGN_BILLING_CONFLICT seats_below_usage');
    expect(await failure(refuse(new SeatChangeRefusedError('seats_not_applicable')).controller.changeSeats(auth(), 'r', { seats: 2 }))).toBe('409 ESIGN_BILLING_CONFLICT seats_not_applicable');
    expect(await failure(refuse(new SeatChangeRefusedError('seats_unchanged')).controller.changeSeats(auth(), 'r', { seats: 2 }))).toBe('409 ESIGN_BILLING_CONFLICT seats_unchanged');
    const { controller } = setup();
    for (const seats of [0, 1001, 1.5, '3', undefined]) expect(await failure(controller.changeSeats(auth(), 'r', { seats }))).toBe('400 VALIDATION_ERROR seats_invalid');
  });

  it('a decrease answers the scheduled period-end change', async () => {
    const { controller } = setup({ seats: { changeSeats: vi.fn(async () => ({ purchased: 5, used: 2, pending_purchased: 3, effective: 'PERIOD_END' })) } as never });
    expect(await controller.changeSeats(auth(), 'r', { seats: 3 })).toEqual({ purchased: 5, used: 2, pending_purchased: 3, effective: 'PERIOD_END' });
  });
});

describe('GET /v1/sign/billing/account (§3.3.4)', () => {
  it('a per-seat subscription: price_unit SEAT, seats { purchased, used, pending_purchased }, can_manage_seats for owner / admin', async () => {
    const owner = (await setup({ used: 2 }).controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(owner).toMatchObject({ price_unit: 'SEAT', seats: { purchased: 5, used: 2, pending_purchased: null }, can_manage_seats: true });
    const sender = (await setup({ roleKeys: ['sign_sender'] }).controller.account(auth('u-2'), 'r')) as Record<string, unknown>;
    expect(sender).toMatchObject({ seats: { purchased: 5 }, can_manage_seats: false });
    const store = (await setup({ seatState: { price_unit: 'SEAT', purchased: 1, pending_purchased: null, changeable: false } }).controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(store['can_manage_seats']).toBe(false);
  });

  it('a per-account subscription or none: seats null, can_manage_seats false', async () => {
    const acct = (await setup({ priceUnit: 'ACCOUNT', seatState: { price_unit: 'ACCOUNT', purchased: null, pending_purchased: null, changeable: false } }).controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(acct).toMatchObject({ price_unit: 'ACCOUNT', seats: null, can_manage_seats: false });
    const none = (await setup({ priceUnit: null, seatState: null }).controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(none).toMatchObject({ price_unit: null, seats: null, can_manage_seats: false });
  });
});

describe('checkout seats (§3.3.1)', () => {
  it('passes a valid seat count to the lifecycle; omits it when absent; refuses a bad count 400', async () => {
    const { controller, lifecycle } = setup();
    await controller.checkout(auth(), 'r', { plan_key: 'aramo-sign-standard-business-v1', seats: 4 });
    expect(lifecycle.startCheckout).toHaveBeenLastCalledWith(expect.objectContaining({ seats: 4 }));
    await controller.checkout(auth(), 'r', { plan_key: 'aramo-sign-standard-business-v1' });
    expect(lifecycle.startCheckout).toHaveBeenLastCalledWith(expect.not.objectContaining({ seats: expect.anything() }));
    expect(await failure(controller.checkout(auth(), 'r', { plan_key: 'p', seats: 0 }))).toBe('400 VALIDATION_ERROR seats_invalid');
  });

  it('a per-account plan with seats maps to 422 seats_not_applicable', () => {
    const e = billingHttpError(new BillingRefusedError('SEATS_NOT_APPLICABLE'), 'r');
    expect([e.statusCode, e.code, e.context.details?.['reason']]).toEqual([422, 'VALIDATION_ERROR', 'seats_not_applicable']);
  });
});
