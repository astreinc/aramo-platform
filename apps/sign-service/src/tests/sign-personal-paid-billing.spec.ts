import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { IdentityRepository, PersonalSignupRepository } from '@aramo/identity';
import { BillingRefusedError, StripeBillingProvider, type SubscriptionLifecycleService } from '@aramo/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EsignBillingController, billingHttpError } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { PersonalSendGate } from '../app/personal/personal-send.gate.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// Sign Catalog v2 §4.3 (P-4) — the sign-service Personal paid billing surface:
//   PP-1  a PERSONAL owner (Personal sending on) starts checkout with tenant_kind PERSONAL
//   PP-2  Personal sending off: checkout refused before the lifecycle is reached
//   PP-3  a plan of the other tenant kind maps to 409 plan_tenant_kind_mismatch
//   PP-4  GET account: `upgrade` is set for a PERSONAL tenant on Free, null on Standard and Business
//   PP-5  GET plans: the Personal Terms for a PERSONAL tenant; the catalog evaluated for its kind
//   PP-6  SIGN_PERSONAL_PAID_CHECKOUT_ENABLED unset / not `1`: no offer, nothing Personal
//         purchasable, checkout 403 ESIGN_FEATURE_NOT_AVAILABLE personal_paid_checkout_not_enabled
//   PP-7  US residents only (declared signup residence; none or unbound ⇒ not US): the offer is
//         unavailable with not_available_in_country, plans not purchasable, checkout 409
//         personal_paid_us_only — the provider is never reached
//   PP-8  Personal checkout / portal return to /personal/settings/billing; Business unchanged

const STANDARD = 'aramo-sign-standard-personal-v1';
const FREE = 'aramo-sign-free-personal-v1';
const OWNER = ['sign:billing:manage', 'sign:envelope:read'];
const auth = (scopes: string[], sub = 'u-owner'): AuthContextType => ({ sub, tenant_id: 't-1', scopes, consumer_type: 'sign' }) as unknown as AuthContextType;

const catalogPlan = (over: Record<string, unknown> = {}) => ({
  key: STANDARD,
  tenant_kind: 'PERSONAL',
  sales_model: 'SELF_SERVICE',
  price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' },
  commitment_months: 12,
  purchasable: true,
  ...over,
});

function setup(o: { kind?: 'PERSONAL' | 'BUSINESS'; personalOpen?: boolean; plan_key?: string | null; purchasable?: boolean; residence?: string | null; unbound?: boolean } = {}) {
  const kind = o.kind ?? 'PERSONAL';
  const open = kind === 'PERSONAL' && o.personalOpen !== false;
  const plan_key = o.plan_key === undefined ? FREE : o.plan_key;
  const lifecycle = {
    account: vi.fn(async () => ({
      subscription: plan_key === null ? null : { plan_key, plan_name: plan_key === FREE ? 'Free Personal' : 'Standard', ended_at: null },
      allowance: plan_key === FREE ? { subscribed: true, limit: 5, daily: { window: 'DAY', limit: 2 } } : { subscribed: true, limit: 25 },
      billing_available: true,
      tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
    })),
    sendingOwner: vi.fn(async () => null),
    tenantActivationState: vi.fn(async () => null),
    catalog: vi.fn(async () => [catalogPlan({ purchasable: o.purchasable ?? true }), { ...catalogPlan({ key: FREE, price: null, purchasable: false }) }]),
    startCheckout: vi.fn(async () => ({ url: 'https://checkout.stripe.test/x' })),
    portal: vi.fn(async () => ({ url: 'https://billing.stripe.test/p' })),
  } as unknown as SubscriptionLifecycleService;
  const tenant = { id: 't-1', kind, status: 'ACTIVE' };
  const ctx = {
    tenantKind: vi.fn(async () => kind),
    tenantOf: vi.fn(async () => tenant),
    personalAuthoringOpen: vi.fn(() => open),
    assertCanAuthorTenant: vi.fn(async () => {
      if (kind === 'PERSONAL' && !open) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Personal sending is not enabled', 403, { requestId: 'r', details: { reason: 'personal_sending_not_enabled' } });
      }
      return tenant;
    }),
  } as unknown as SenderContextService;
  const personal = { ensureFreeSubscription: vi.fn(async () => undefined) } as unknown as PersonalSendGate;
  const identity = { findUserById: vi.fn(async () => ({ id: 'u-owner', email: 'me@example.test' })) } as unknown as IdentityRepository;
  const owners = { activate: vi.fn(async () => 'ALREADY') } as unknown as EsignOwnerActivationService;
  const signups = { declaredResidenceOf: vi.fn(async () => (o.residence === undefined ? 'US' : o.residence)) } as unknown as PersonalSignupRepository;
  const controller = new EsignBillingController(lifecycle, new StripeBillingProvider(), owners, ctx, identity, personal, undefined, undefined, o.unbound === true ? undefined : signups);
  return { controller, lifecycle, personal, signups };
}

describe('Sign Catalog v2 — Personal paid billing (sign-service)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env['SIGN_PERSONAL_PAID_CHECKOUT_ENABLED'] = '1';
    process.env['SIGN_SENDER_WEB_BASE_URL'] = 'https://esign.example.test/';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('PP-1 a PERSONAL owner starts the checkout with the tenant kind; the URLs stay server-built', async () => {
    const { controller, lifecycle } = setup();
    expect(await controller.checkout(auth(OWNER), 'r', { plan_key: STANDARD, accept_terms: true })).toEqual({ url: 'https://checkout.stripe.test/x' });
    expect(lifecycle.startCheckout).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't-1', plan_key: STANDARD, accept_terms: true, tenant_kind: 'PERSONAL', user_email: 'me@example.test' }));
  });

  it('PP-2 with Personal sending off, a PERSONAL checkout is refused before the lifecycle; a non-owner is refused too', async () => {
    const off = setup({ personalOpen: false });
    await expect(off.controller.checkout(auth(OWNER), 'r', { plan_key: STANDARD })).rejects.toMatchObject({ statusCode: 403 });
    expect(off.lifecycle.startCheckout).not.toHaveBeenCalled();
    const on = setup();
    await expect(on.controller.checkout(auth(['sign:envelope:read']), 'r', { plan_key: STANDARD })).rejects.toMatchObject({ statusCode: 403 });
    expect(on.lifecycle.startCheckout).not.toHaveBeenCalled();
  });

  it('PP-3 a plan of the other tenant kind is a 409 plan_tenant_kind_mismatch', () => {
    const e = billingHttpError(new BillingRefusedError('PLAN_TENANT_KIND_MISMATCH'), 'r');
    expect(`${e.code}:${e.statusCode}:${String(e.context.details?.['reason'])}`).toBe('ESIGN_BILLING_CONFLICT:409:plan_tenant_kind_mismatch');
  });

  it('PP-4 GET account: the upgrade offer on Free; none on Standard or for a Business tenant', async () => {
    const onFree = setup();
    const a = (await onFree.controller.account(auth(OWNER), 'r')) as Record<string, unknown>;
    expect(onFree.personal!.ensureFreeSubscription).toHaveBeenCalled();
    expect(a).toMatchObject({ tenant_kind: 'PERSONAL', self_service_eligible: true, can_manage_billing: true, allowance: { limit: 5, daily: { limit: 2 } } });
    expect(a['upgrade']).toEqual({ available: true, reason: null, plan_key: STANDARD, price_minor: 1000, commitment_months: 12 });
    expect(onFree.lifecycle.catalog).toHaveBeenCalledWith('sign', 't-1', 'PERSONAL');

    // A non-owner sees the offer but cannot take it; no price configured → not available.
    expect(((await onFree.controller.account(auth(['sign:envelope:read'], 'u-x'), 'r')) as Record<string, unknown>)['upgrade']).toMatchObject({ available: false, reason: 'billing_manage_required' });
    expect(((await setup({ purchasable: false }).controller.account(auth(OWNER), 'r')) as Record<string, unknown>)['upgrade']).toMatchObject({ available: false, reason: 'not_purchasable' });

    const onStandard = (await setup({ plan_key: STANDARD }).controller.account(auth(OWNER), 'r')) as Record<string, unknown>;
    expect(onStandard['upgrade']).toBeNull();
    expect(onStandard['allowance']).toEqual({ subscribed: true, limit: 25 });
    expect(((await setup({ kind: 'BUSINESS', plan_key: null }).controller.account(auth(OWNER), 'r')) as Record<string, unknown>)['upgrade']).toBeNull();
  });

  it('PP-5 GET plans: the catalog is evaluated for the tenant kind and carries the Personal Terms', async () => {
    const { controller, lifecycle } = setup();
    const out = (await controller.plans(auth(OWNER), 'r')) as { terms: { version: string; url: string } | null };
    expect(lifecycle.catalog).toHaveBeenCalledWith('sign', 't-1', 'PERSONAL');
    expect(out.terms).toEqual({ version: '1.0', url: 'https://sign.aramo.ai/legal/personal-terms/1.0' });
  });

  const code = (p: Promise<unknown>) => p.then(() => 'OK', (e: AramoError) => `${e.code}:${e.statusCode}:${String(e.context.details?.['reason'] ?? '')}`);

  it('PP-6 dark by default: no offer, no purchasable Personal plan, checkout refused 403 before the provider', async () => {
    for (const v of [undefined, '0', 'true', 'yes', ' 2 ']) {
      if (v === undefined) delete process.env['SIGN_PERSONAL_PAID_CHECKOUT_ENABLED'];
      else process.env['SIGN_PERSONAL_PAID_CHECKOUT_ENABLED'] = v;
      const { controller, lifecycle } = setup();
      expect(((await controller.account(auth(OWNER), 'r')) as Record<string, unknown>)['upgrade']).toBeNull();
      const plans = (await controller.plans(auth(OWNER), 'r')) as { plans: { key: string; purchasable: boolean }[] };
      expect(plans.plans.filter((p) => p.purchasable)).toEqual([]);
      expect(await code(controller.checkout(auth(OWNER), 'r', { plan_key: STANDARD, accept_terms: true }))).toBe('ESIGN_FEATURE_NOT_AVAILABLE:403:personal_paid_checkout_not_enabled');
      expect(lifecycle.startCheckout).not.toHaveBeenCalled();
    }
  });

  it('PP-7 US residents only: a non-US, missing or unreadable residence never reaches the provider', async () => {
    for (const o of [{ residence: 'IN' }, { residence: null }, { unbound: true }]) {
      const { controller, lifecycle } = setup(o);
      expect(((await controller.account(auth(OWNER), 'r')) as Record<string, unknown>)['upgrade']).toMatchObject({ available: false, reason: 'not_available_in_country', plan_key: STANDARD });
      const plans = (await controller.plans(auth(OWNER), 'r')) as { plans: { key: string; purchasable: boolean }[] };
      expect(plans.plans.find((p) => p.key === STANDARD)!.purchasable).toBe(false);
      expect(await code(controller.checkout(auth(OWNER), 'r', { plan_key: STANDARD, accept_terms: true }))).toBe('ESIGN_BILLING_CONFLICT:409:personal_paid_us_only');
      expect(lifecycle.startCheckout).not.toHaveBeenCalled();
    }
    const failing = setup();
    (failing.signups.declaredResidenceOf as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    expect(await code(failing.controller.checkout(auth(OWNER), 'r', { plan_key: STANDARD, accept_terms: true }))).toBe('ESIGN_BILLING_CONFLICT:409:personal_paid_us_only');
    // A US resident: purchasable and the residence of THIS tenant was read.
    const us = setup();
    expect(((await us.controller.plans(auth(OWNER), 'r')) as { plans: { key: string; purchasable: boolean }[] }).plans.find((p) => p.key === STANDARD)!.purchasable).toBe(true);
    expect(us.signups.declaredResidenceOf).toHaveBeenCalledWith('t-1');
  });

  it('PP-8 Personal checkout and portal return to /personal/settings/billing; Business unchanged', async () => {
    const p = setup();
    await p.controller.checkout(auth(OWNER), 'r', { plan_key: STANDARD, accept_terms: true });
    expect(p.lifecycle.startCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: 'https://esign.example.test/personal/settings/billing?checkout=success',
        cancel_url: 'https://esign.example.test/personal/settings/billing?checkout=canceled',
      }),
    );
    await p.controller.portal(auth(OWNER), 'r');
    expect(p.lifecycle.portal).toHaveBeenCalledWith('t-1', 'sign', 'https://esign.example.test/personal/settings/billing');
    const b = setup({ kind: 'BUSINESS', plan_key: null });
    await b.controller.checkout(auth(OWNER), 'r', { plan_key: 'aramo-sign-standard-business-v1' });
    expect(b.lifecycle.startCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url: 'https://esign.example.test/sign/settings/billing?checkout=success',
        cancel_url: 'https://esign.example.test/sign/settings/billing?checkout=canceled',
        tenant_kind: 'BUSINESS',
      }),
    );
    await b.controller.portal(auth(OWNER), 'r');
    expect(b.lifecycle.portal).toHaveBeenCalledWith('t-1', 'sign', 'https://esign.example.test/sign/settings/billing');
  });
});
