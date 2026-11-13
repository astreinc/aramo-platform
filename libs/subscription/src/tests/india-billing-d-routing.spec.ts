import { describe, expect, it, vi } from 'vitest';

import { BillingCommandService, BillingCommandError } from '../lib/billing/billing-command.service.js';
import type { BillingProviderPort, BillingProviderSeatPort, ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import { StaticBillingGatewayRegistry } from '../lib/billing/gateway-registry.js';
import { BillingRegionService } from '../lib/billing/region/billing-region.service.js';
import type { BillingCountryPort } from '../lib/billing/region/billing-country.port.js';
import { SeatBillingService } from '../lib/billing/seat-billing.service.js';
import { BillingRefusedError, SubscriptionLifecycleService, billingSegmentOf, webActivationCountryOk } from '../lib/billing/subscription-lifecycle.service.js';
import { type PlanVersionContent, planVersionChecksum, planVersionContentFromRows, withPriceUnit } from '../lib/plan-version.js';

// Aramo India Billing Regions + Razorpay Implementation Directive v1.0 (LOCKED) — WS-D:
//   §4.4 / Q6   checkout routes by the account's country: US → Stripe (the bound port, unchanged);
//               India OFF ⇒ refused before any provider call (HALT §8: nothing sells in India while OFF);
//               India ON ⇒ Razorpay (its price pin, its billing account, a RAZORPAY CheckoutIntent).
//   Q6          activation guard: STRIPE keeps the US account_country rule; RAZORPAY activates only when
//               the tenant's region sells the segment through Razorpay (fail closed).
//   Q7          cancel and seat quantity route by the subscription's billing_provider; refunds, credits and
//               discounts stay Stripe-only (typed refusal).

const contentOf = (kind: 'BUSINESS' | 'PERSONAL'): PlanVersionContent =>
  planVersionContentFromRows({
    plan: {
      key: kind === 'PERSONAL' ? 'aramo-sign-standard-personal-v1' : 'aramo-sign-standard-business-v1',
      product_key: 'sign',
      name: kind === 'PERSONAL' ? 'Standard' : 'Standard Business',
      description: null,
      tenant_kind: kind,
      sales_model: 'SELF_SERVICE',
      list_price_minor: kind === 'PERSONAL' ? 1000 : 1500,
      currency: 'USD',
      reference_price_minor: null,
      reference_price_substantiated: false,
      billing_interval: 'MONTH',
      commitment_months: null,
      eligibility: null,
      support_tier: 'BASIC',
    },
    allowances: [{ allowance_key: 'sign.envelopes', included_quantity: null, unlimited: true, period: 'MONTHLY' }],
    allowance_windows: [],
    capacities: [{ capacity_key: 'sign.storage_bytes', limit_quantity: 10737418240, unlimited: false }],
    features: [],
  });
const versionOf = (c: PlanVersionContent) => ({ id: 'v1', content: c, content_checksum: planVersionChecksum(c) });

type RegionRow = {
  country: string;
  gateway: string;
  currency: string;
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: string;
  selling_entity: { id: string; key: string; display_name: string; legal_name: string; country: string; active: boolean };
};
const US_REGION: RegionRow = {
  country: 'US', gateway: 'STRIPE', currency: 'USD', enabled: true, personal_web_enabled: true, business_web_enabled: true, price_tax_mode: 'UNSET',
  selling_entity: { id: 'e-us', key: 'aramo-us', display_name: 'Aramo', legal_name: 'Aramo', country: 'US', active: true },
};
const IN_OFF: RegionRow = {
  country: 'IN', gateway: 'RAZORPAY', currency: 'INR', enabled: false, personal_web_enabled: false, business_web_enabled: false, price_tax_mode: 'UNSET',
  selling_entity: { id: 'e-in', key: 'aramo-in', display_name: 'Aramo India', legal_name: 'Aramo India', country: 'IN', active: false },
};
const IN_ON: RegionRow = { ...IN_OFF, enabled: true, personal_web_enabled: true, business_web_enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { ...IN_OFF.selling_entity, active: true } };

/** The real region store over a fake table; the gateway configured-check is the registry's. */
function regionStore(rows: RegionRow[], configured: (p: string) => boolean = () => true) {
  const prisma = { billingRegion: { findUnique: async ({ where }: { where: { country: string } }) => rows.find((r) => r.country === where.country) ?? null } };
  return new BillingRegionService(prisma as never, configured as never);
}

const countryPort = (country: string | null, kind: 'PERSONAL' | 'BUSINESS' = 'PERSONAL'): BillingCountryPort => ({ countryOf: vi.fn(async () => ({ tenant_kind: kind, country })) });

function gatewayPort(provider: 'STRIPE' | 'RAZORPAY', configured = true) {
  const sessions: Record<string, unknown>[] = [];
  const accounts: Array<string | null> = [];
  const port = {
    provider,
    isConfigured: () => configured,
    mode: () => 'test',
    upsertBillingAccount: vi.fn(async (existing: string | null) => {
      accounts.push(existing);
      return provider === 'STRIPE' ? 'cus_1' : 'cust_rzp_1';
    }),
    createCheckoutSession: vi.fn(async (r: Record<string, unknown>) => {
      sessions.push(r);
      return provider === 'STRIPE' ? { session_ref: 'cs_1', url: 'https://checkout.stripe.test/s' } : { session_ref: 'sub_rzp_1', url: 'https://rzp.io/i/sub_rzp_1' };
    }),
    retrieveSubscription: vi.fn(),
  };
  return { port: port as unknown as BillingProviderPort, sessions, accounts, raw: port };
}

function checkoutHarness(o: { kind: 'PERSONAL' | 'BUSINESS'; country: string | null; regions?: RegionRow[]; bound?: boolean; razorpayConfigured?: boolean; profileCountry?: string }) {
  const content = contentOf(o.kind);
  const plan = { id: 'plan-1', key: content.plan.key, product_key: 'sign', sellable: true, status: 'ACTIVE', sales_model: 'SELF_SERVICE', tenant_kind: o.kind };
  const version = versionOf(content);
  const intents: Record<string, unknown>[] = [];
  const priceLookups: string[] = [];
  const accountKeys: string[] = [];
  const tx = {
    $executeRaw: async () => 1,
    tenantSubscription: { findFirst: async () => null },
    checkoutIntent: { create: async (a: { data: Record<string, unknown> }) => (intents.push(a.data), a.data) },
  };
  const prisma = {
    plan: { findUnique: async () => plan },
    planVersion: { findFirst: async () => version },
    planVersionPrice: {
      findUnique: async ({ where }: { where: { plan_version_id_provider: { provider: string } } }) => {
        const p = where.plan_version_id_provider.provider;
        priceLookups.push(p);
        return { provider_price_ref: p === 'STRIPE' ? 'price_stripe' : 'plan_rzp' };
      },
    },
    tenantSubscription: { findFirst: async () => null },
    tenantBillingAccount: {
      findUnique: async ({ where }: { where: { tenant_id_provider: { provider: string } } }) => (accountKeys.push(where.tenant_id_provider.provider), null),
      upsert: async ({ where }: { where: { tenant_id_provider: { provider: string } } }) => (accountKeys.push(`upsert:${where.tenant_id_provider.provider}`), {}),
    },
    checkoutIntent: { update: async () => ({}) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const stripe = gatewayPort('STRIPE');
  const razorpay = gatewayPort('RAZORPAY', o.razorpayConfigured ?? true);
  const registry = new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe.port }, RAZORPAY: { billing: razorpay.port } });
  const locks: Array<[string, string | undefined]> = [];
  const profileCountry = o.profileCountry ?? o.country ?? 'US';
  const orgProfile = {
    eligibleProfile: async () => ({ profile: { legal_name: 'Acme', billing_email: 'b@acme.test', address: { line1: '1', line2: null, city: 'A', state: 'S', postal_code: '1', country: profileCountry } } }),
    lockRegion: async (t: string, r?: string) => void locks.push([t, r]),
    domainAuthoritative: async () => true,
  };
  const bound = o.bound !== false;
  const regions = regionStore(o.regions ?? [US_REGION, IN_OFF], (p) => registry.configured(p as 'STRIPE' | 'RAZORPAY'));
  const svc = new SubscriptionLifecycleService(
    prisma as never, {} as never, stripe.port, {} as never, undefined, [], orgProfile as never,
    undefined, undefined, undefined, undefined, undefined, registry,
    bound ? countryPort(o.country, o.kind) : undefined, bound ? regions : undefined,
  );
  const start = () =>
    svc.startCheckout({ tenant_id: 't-1', product_key: 'sign', user_id: 'u-1', user_email: 'o@acme.test', plan_key: content.plan.key, success_url: 'https://e/ok', cancel_url: 'https://e/no', tenant_kind: o.kind });
  return { start, intents, priceLookups, accountKeys, stripe, razorpay, locks, svc };
}

const refusal = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof BillingRefusedError ? `${e.reason}${e.message !== e.reason ? `:${e.message}` : ''}` : String(e)),
  );

describe('India Billing §4.4 / Q6 — checkout routes by the account country', () => {
  it('US Personal: Stripe exactly as before (bound port, STRIPE price pin, STRIPE intent, collect address)', async () => {
    const h = checkoutHarness({ kind: 'PERSONAL', country: 'US' });
    expect(await h.start()).toEqual({ url: 'https://checkout.stripe.test/s' });
    expect(h.priceLookups).toEqual(['STRIPE']);
    expect(h.intents[0]).toMatchObject({ provider: 'STRIPE' });
    expect(h.stripe.sessions[0]).toMatchObject({ price_ref: 'price_stripe', collect_address: true });
    expect(h.razorpay.raw.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('US Business: Stripe, the STRIPE billing account, and the profile held to the US', async () => {
    const h = checkoutHarness({ kind: 'BUSINESS', country: 'US' });
    expect(await h.start()).toEqual({ url: 'https://checkout.stripe.test/s' });
    expect(h.accountKeys).toEqual(['STRIPE', 'upsert:STRIPE']);
    expect(h.locks).toEqual([['t-1', 'US']]);
    expect(h.intents[0]).toMatchObject({ provider: 'STRIPE' });
  });

  it('legacy (no country port / region store bound): the Stripe route, no region read', async () => {
    const h = checkoutHarness({ kind: 'PERSONAL', country: 'IN', bound: false });
    expect(await h.start()).toEqual({ url: 'https://checkout.stripe.test/s' });
    expect(h.intents[0]).toMatchObject({ provider: 'STRIPE' });
  });

  it('HALT §8 — India OFF: a Personal resident of India is refused before any intent or provider call', async () => {
    const h = checkoutHarness({ kind: 'PERSONAL', country: 'IN' });
    expect(await refusal(h.start())).toBe('BILLING_REGION_NOT_SELLABLE:region_disabled');
    expect(h.intents).toEqual([]);
    expect(h.razorpay.raw.createCheckoutSession).not.toHaveBeenCalled();
    expect(h.stripe.raw.createCheckoutSession).not.toHaveBeenCalled();
    expect(h.razorpay.raw.upsertBillingAccount).not.toHaveBeenCalled();
  });

  it('HALT §8 — India OFF: a Business organization in India gets the existing country refusal; nothing is sold', async () => {
    const h = checkoutHarness({ kind: 'BUSINESS', country: 'IN' });
    expect(await refusal(h.start())).toBe('ORGANIZATION_PROFILE_REQUIRED:organization_country_not_supported');
    expect(h.intents).toEqual([]);
    expect(h.locks).toEqual([]);
    expect(h.razorpay.raw.createCheckoutSession).not.toHaveBeenCalled();
    expect(h.stripe.raw.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('India region ON but its Personal switch OFF: still refused (segment_disabled)', async () => {
    const h = checkoutHarness({ kind: 'PERSONAL', country: 'IN', regions: [US_REGION, { ...IN_ON, personal_web_enabled: false }] });
    expect(await refusal(h.start())).toBe('BILLING_REGION_NOT_SELLABLE:segment_disabled');
    expect(h.intents).toEqual([]);
  });

  it('a country without a region (or none declared) is refused; a Business without a country is an incomplete profile', async () => {
    expect(await refusal(checkoutHarness({ kind: 'PERSONAL', country: 'GB' }).start())).toBe('BILLING_REGION_NOT_SELLABLE:region_not_supported');
    expect(await refusal(checkoutHarness({ kind: 'PERSONAL', country: null }).start())).toBe('BILLING_REGION_NOT_SELLABLE:region_not_supported');
    expect(await refusal(checkoutHarness({ kind: 'BUSINESS', country: null }).start())).toBe('ORGANIZATION_PROFILE_REQUIRED:organization_profile_incomplete');
    expect(await refusal(checkoutHarness({ kind: 'BUSINESS', country: 'GB' }).start())).toBe('ORGANIZATION_PROFILE_REQUIRED:organization_country_not_supported');
  });

  it('India ON but Razorpay not configured (G-2): BILLING_UNAVAILABLE, no provider call', async () => {
    const h = checkoutHarness({ kind: 'PERSONAL', country: 'IN', regions: [US_REGION, IN_ON], razorpayConfigured: false });
    expect(await refusal(h.start())).toBe('BILLING_UNAVAILABLE');
    expect(h.intents).toEqual([]);
    expect(h.razorpay.raw.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('India ON: a Personal resident checks out through Razorpay (its pin, a RAZORPAY intent, the hosted link)', async () => {
    const h = checkoutHarness({ kind: 'PERSONAL', country: 'IN', regions: [US_REGION, IN_ON] });
    expect(await h.start()).toEqual({ url: 'https://rzp.io/i/sub_rzp_1' });
    expect(h.priceLookups).toEqual(['RAZORPAY']);
    expect(h.intents[0]).toMatchObject({ provider: 'RAZORPAY' });
    expect(h.razorpay.sessions[0]).toMatchObject({ price_ref: 'plan_rzp', account_ref: null });
    expect(h.accountKeys).toEqual(['RAZORPAY']);
    expect(h.stripe.raw.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('India ON: a Business organization in India checks out through Razorpay on its (tenant, RAZORPAY) account, held to IN', async () => {
    const h = checkoutHarness({ kind: 'BUSINESS', country: 'IN', regions: [US_REGION, IN_ON] });
    expect(await h.start()).toEqual({ url: 'https://rzp.io/i/sub_rzp_1' });
    expect(h.accountKeys).toEqual(['RAZORPAY', 'upsert:RAZORPAY']);
    expect(h.razorpay.raw.upsertBillingAccount).toHaveBeenCalledTimes(1);
    expect(h.locks).toEqual([['t-1', 'IN']]);
    expect(h.intents[0]).toMatchObject({ provider: 'RAZORPAY' });
  });

  it('a Business profile whose country differs from the routed one is refused (no region switch, Q10)', async () => {
    const h = checkoutHarness({ kind: 'BUSINESS', country: 'IN', regions: [US_REGION, IN_ON], profileCountry: 'US' });
    expect(await refusal(h.start())).toBe('ORGANIZATION_PROFILE_REQUIRED:organization_country_not_supported');
    expect(h.intents).toEqual([]);
  });

  it('checkoutRoute: unbound ⇒ legacy STRIPE; a lookup failure fails closed', async () => {
    const unbound = new SubscriptionLifecycleService({} as never, {} as never, gatewayPort('STRIPE').port, {} as never);
    expect(await unbound.checkoutRoute('t-1', 'PERSONAL')).toEqual({ ok: true, gateway: 'STRIPE', region: null, country: null });
    const failing = new SubscriptionLifecycleService(
      {} as never, {} as never, gatewayPort('STRIPE').port, {} as never, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { countryOf: async () => Promise.reject(new Error('down')) }, regionStore([US_REGION]),
    );
    expect(await failing.checkoutRoute('t-1', 'PERSONAL')).toEqual({ ok: false, reason: 'region_not_supported', country: null });
  });
});

describe('India Billing Q6 — the activation country guard', () => {
  it('webActivationCountryOk: STRIPE keeps the US account_country rule; RAZORPAY needs the region verdict', () => {
    expect(webActivationCountryOk('STRIPE', 'US', null)).toBe(true);
    expect(webActivationCountryOk('STRIPE', ' us ', false)).toBe(true);
    expect(webActivationCountryOk('STRIPE', 'IN', true)).toBe(false);
    expect(webActivationCountryOk('STRIPE', null, true)).toBe(false);
    expect(webActivationCountryOk('RAZORPAY', null, true)).toBe(true);
    expect(webActivationCountryOk('RAZORPAY', 'US', false)).toBe(false);
    expect(webActivationCountryOk('RAZORPAY', 'US', null)).toBe(false);
    expect(billingSegmentOf('PERSONAL')).toBe('PERSONAL');
    expect(billingSegmentOf(null)).toBe('BUSINESS');
  });

  const content = contentOf('PERSONAL');
  function activation(o: { regions?: RegionRow[]; bound?: boolean; country?: string | null }) {
    const version = versionOf(content);
    const created: Record<string, unknown>[] = [];
    const flags: unknown[][] = [];
    const tx = {
      $executeRaw: async (_q: TemplateStringsArray, ...v: unknown[]) => (flags.push(v), 1),
      tenantSubscription: {
        findFirst: async () => null,
        update: async (a: { data: Record<string, unknown> }) => a.data,
        create: async (a: { data: Record<string, unknown> }) => (created.push(a.data), a.data),
      },
      billingReconciliationFlag: { updateMany: async () => ({ count: 0 }) },
      planVersion: { findUniqueOrThrow: async () => version, findFirst: async () => version },
      plan: { findUniqueOrThrow: async () => ({ id: 'plan-1', key: content.plan.key, product_key: 'sign' }) },
      checkoutIntent: { update: async () => ({}) },
    };
    const intent = { id: 'i-1', tenant_id: 't-1', user_id: 'u-1', plan_id: 'plan-1', status: 'CREATED', seat_quantity: null, plan: { key: content.plan.key, product_key: 'sign', tenant_kind: 'PERSONAL' } };
    const prisma = {
      tenantSubscription: { findFirst: async () => null },
      checkoutIntent: { findUnique: async () => intent },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const stripe = gatewayPort('STRIPE');
    const razorpay = gatewayPort('RAZORPAY');
    const registry = new StaticBillingGatewayRegistry({ STRIPE: { billing: stripe.port }, RAZORPAY: { billing: razorpay.port } });
    const bound = o.bound !== false;
    const svc = new SubscriptionLifecycleService(
      prisma as never, {} as never, stripe.port, {} as never, undefined, [], undefined, undefined, undefined, undefined, undefined, undefined, registry,
      bound ? countryPort(o.country === undefined ? 'IN' : o.country) : undefined, bound ? regionStore(o.regions ?? [US_REGION, IN_OFF], (p) => registry.configured(p as 'STRIPE' | 'RAZORPAY')) : undefined,
    );
    const state = (provider: 'STRIPE' | 'RAZORPAY', account_country: string | null): ProviderSubscriptionState => ({
      provider,
      subscription_ref: 'sub_1',
      account_ref: 'acct_1',
      provider_status: 'active',
      current_period_start: new Date('2026-11-01T00:00:00Z'),
      current_period_end: new Date('2026-12-01T00:00:00Z'),
      cancel_at_period_end: false,
      price_ref: null,
      tenant_id: 't-1',
      intent_id: 'i-1',
      account_country,
    });
    return { svc, state, created, flags };
  }

  it('HALT §8 — a RAZORPAY activation while India is OFF is held (IGNORED, country flag), never opened', async () => {
    const h = activation({});
    const r = await h.svc.applyProviderState(h.state('RAZORPAY', null), 'sign');
    expect(r.outcome).toBe('IGNORED');
    expect(r.detail).toContain('billing_country_not_supported');
    expect(h.created).toEqual([]);
    expect(h.flags.some((v) => v.includes('billing_country_not_supported'))).toBe(true);
  });

  it('a RAZORPAY activation without the country port / region store is held (fail closed)', async () => {
    const h = activation({ bound: false });
    expect((await h.svc.applyProviderState(h.state('RAZORPAY', null), 'sign')).outcome).toBe('IGNORED');
    expect(h.created).toEqual([]);
  });

  it('a RAZORPAY activation for a US tenant (region gateway STRIPE) is held', async () => {
    const h = activation({ regions: [US_REGION, IN_ON], country: 'US' });
    expect((await h.svc.applyProviderState(h.state('RAZORPAY', null), 'sign')).outcome).toBe('IGNORED');
    expect(h.created).toEqual([]);
  });

  it('India ON: a RAZORPAY activation of an India resident opens the subscription (no address needed)', async () => {
    const h = activation({ regions: [US_REGION, IN_ON] });
    const r = await h.svc.applyProviderState(h.state('RAZORPAY', null), 'sign');
    expect(r.outcome).toBe('APPLIED');
    expect(h.created[0]).toMatchObject({ billing_provider: 'RAZORPAY', billing_subscription_ref: 'sub_1' });
  });

  it('STRIPE is unchanged: US account_country opens, any other is held — whatever the region store says', async () => {
    const us = activation({ regions: [US_REGION, IN_ON] });
    expect((await us.svc.applyProviderState(us.state('STRIPE', 'US'), 'sign')).outcome).toBe('APPLIED');
    const india = activation({ regions: [US_REGION, IN_ON] });
    expect((await india.svc.applyProviderState(india.state('STRIPE', 'IN'), 'sign')).outcome).toBe('IGNORED');
    expect(india.created).toEqual([]);
  });
});

describe('India Billing Q7 — seats route by the subscription billing provider', () => {
  const SEAT = withPriceUnit(contentOf('BUSINESS'), 'SEAT');
  function seats(billing_provider: string) {
    const row = { id: 'sub-1', source: 'SELF_SERVICE', billing_provider, billing_subscription_ref: 'sub_x', current_period_end: new Date('2026-12-01T00:00:00Z'), seat_quantity: 3, seat_pending_quantity: null, plan_version: versionOf(SEAT) };
    const tx = { $executeRaw: async () => 1, tenantSubscription: { update: async () => row } };
    const prisma = { tenantSubscription: { findFirst: async () => row }, $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    const port = (provider: 'STRIPE' | 'RAZORPAY') => {
      const calls: number[] = [];
      const p: BillingProviderSeatPort = { provider, isConfigured: () => true, updateSubscriptionQuantity: async (_r, q) => (calls.push(q), {} as ProviderSubscriptionState) };
      return { p, calls };
    };
    const stripe = port('STRIPE');
    const razorpay = port('RAZORPAY');
    const registry = new StaticBillingGatewayRegistry({ STRIPE: { billing: gatewayPort('STRIPE').port, seats: stripe.p }, RAZORPAY: { billing: gatewayPort('RAZORPAY').port, seats: razorpay.p } });
    return { svc: new SeatBillingService(prisma as never, stripe.p, registry), stripe, razorpay };
  }

  it('a Razorpay-billed per-seat subscription changes its seats through Razorpay; Stripe stays on the bound port', async () => {
    const r = seats('RAZORPAY');
    expect((await r.svc.seatState('t-1', 'sign'))?.changeable).toBe(true);
    expect(await r.svc.changeSeats({ tenant_id: 't-1', product_key: 'sign', seats: 5, used: 2 })).toMatchObject({ purchased: 5, effective: 'NOW' });
    expect(r.razorpay.calls).toEqual([5]);
    expect(r.stripe.calls).toEqual([]);
    const s = seats('STRIPE');
    await s.svc.changeSeats({ tenant_id: 't-1', product_key: 'sign', seats: 4, used: 2 });
    expect(s.stripe.calls).toEqual([4]);
    expect(s.razorpay.calls).toEqual([]);
  });

  it('a store-billed row is still not changeable', async () => {
    expect((await seats('APP_STORE').svc.seatState('t-1', 'sign'))?.changeable).toBe(false);
  });
});

describe('India Billing Q7 — provider commands route by the subscription billing provider', () => {
  function commandHarness(billing_provider: string) {
    const created: Record<string, unknown>[] = [];
    const row = { id: 'sub-1', billing_provider, billing_subscription_ref: 'sub_x', billing_account_ref: 'acct_x' };
    const tx = {
      $executeRaw: async () => 1,
      selfServiceBillingRequest: { findUnique: async () => ({ id: 'ssr-1', tenant_id: '01900000-0000-7000-8000-000000000001', product_key: 'sign', target_ref: 'sub_x' }) },
      commercialChangeRequest: { findUnique: async () => ({ id: 'cr-1', action_type: 'CREDIT', state: 'APPROVED', tenant_id: '01900000-0000-7000-8000-000000000001', product_key: 'sign' }) },
      billingProviderCommand: { findFirst: async () => null, create: async (a: { data: Record<string, unknown> }) => (created.push(a.data), a.data) },
      tenantSubscription: { findFirst: async () => row },
      billingReconciliationFlag: { findFirst: async () => null },
      checkoutIntent: { findFirst: async () => null },
    };
    let claimed = false;
    const updates: Record<string, unknown>[] = [];
    const claimArgs: unknown[][] = [];
    const prisma = {
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      $queryRaw: async (_q: TemplateStringsArray, ...v: unknown[]) => {
        claimArgs.push(v);
        if (claimed) return [];
        claimed = true;
        return [{ ...created[0], attempts: 1, state: 'DISPATCHING' }];
      },
      billingProviderCommand: { updateMany: async (a: { data: Record<string, unknown> }) => (updates.push(a.data), { count: 1 }) },
    };
    const commandsOf = (provider: 'STRIPE' | 'RAZORPAY') => ({
      provider,
      isConfigured: () => true,
      mode: () => 'test' as const,
      cancelSubscription: vi.fn(async () => undefined),
      retrieveCheckoutSession: vi.fn(),
      expireCheckoutSession: vi.fn(),
    });
    const stripeCommands = commandsOf('STRIPE');
    const razorpayCommands = commandsOf('RAZORPAY');
    const stripeBilling = { ...gatewayPort('STRIPE').raw, retrieveSubscription: vi.fn(async () => ({ provider: 'STRIPE', tenant_id: null, provider_status: 'active', cancel_at_period_end: false })) };
    const razorpayBilling = { ...gatewayPort('RAZORPAY').raw, retrieveSubscription: vi.fn(async () => ({ provider: 'RAZORPAY', tenant_id: null, provider_status: 'active', cancel_at_period_end: false })) };
    const registry = new StaticBillingGatewayRegistry({
      STRIPE: { billing: stripeBilling as never, commands: stripeCommands as never },
      RAZORPAY: { billing: razorpayBilling as never, commands: razorpayCommands as never },
    });
    const svc = new BillingCommandService(prisma as never, stripeBilling as never, {} as never, stripeCommands as never, undefined, registry);
    return { svc, created, updates, claimArgs, stripeCommands, razorpayCommands, razorpayBilling, stripeBilling };
  }
  const TENANT = '01900000-0000-7000-8000-000000000001';
  const cancel = { self_service_request_id: '01900000-0000-7000-8000-0000000000aa', step: 'cancel', command_kind: 'SUBSCRIPTION_CANCEL' as const, mode: 'AT_PERIOD_END' as const, tenant_id: TENANT, product_key: 'sign' as const, target_ref: 'sub_x', created_by: 'u-1', at: new Date() };

  it('a cancel of a Razorpay-billed subscription is a RAZORPAY command, dispatched through Razorpay', async () => {
    const h = commandHarness('RAZORPAY');
    await h.svc.enqueue(cancel);
    expect(h.created[0]).toMatchObject({ provider: 'RAZORPAY', command_kind: 'SUBSCRIPTION_CANCEL' });
    const tally = await h.svc.dispatchDue(new Date());
    expect(tally.accepted).toBe(1);
    // The claim names the dispatchable gateways: STRIPE and the configured, test-mode RAZORPAY.
    expect(h.claimArgs[0]).toContainEqual(['STRIPE', 'RAZORPAY']);
    expect(h.razorpayBilling.retrieveSubscription).toHaveBeenCalledWith('sub_x');
    expect(h.razorpayCommands.cancelSubscription).toHaveBeenCalledWith('sub_x', { at_period_end: true }, expect.any(String));
    expect(h.stripeCommands.cancelSubscription).not.toHaveBeenCalled();
  });

  it('a cancel of a Stripe-billed subscription is unchanged (STRIPE, the bound ports)', async () => {
    const h = commandHarness('STRIPE');
    await h.svc.enqueue(cancel);
    expect(h.created[0]).toMatchObject({ provider: 'STRIPE' });
    await h.svc.dispatchDue(new Date());
    expect(h.stripeCommands.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(h.razorpayCommands.cancelSubscription).not.toHaveBeenCalled();
  });

  it('§7 — a credit, discount or refund of a Razorpay-billed subscription is refused (typed), nothing recorded', async () => {
    const h = commandHarness('RAZORPAY');
    const err = await h.svc
      .enqueue({ change_request_id: '01900000-0000-7000-8000-0000000000bb', step: 'credit', command_kind: 'CREDIT_GRANT', tenant_id: TENANT, product_key: 'sign', target_ref: 'acct_x', params: { subscription_id: '01900000-0000-7000-8000-0000000000cc', amount_minor: 100, currency: 'INR' }, created_by: 'u-1', at: new Date() })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BillingCommandError);
    expect((err as BillingCommandError).code).toBe('GATEWAY_ADJUSTMENT_NOT_SUPPORTED');
    expect(h.created).toEqual([]);
    // The same credit of a Stripe-billed subscription is recorded as before (STRIPE).
    const stripe = commandHarness('STRIPE');
    await stripe.svc.enqueue({ change_request_id: '01900000-0000-7000-8000-0000000000bb', step: 'credit', command_kind: 'CREDIT_GRANT', tenant_id: TENANT, product_key: 'sign', target_ref: 'acct_x', params: { subscription_id: '01900000-0000-7000-8000-0000000000cc', amount_minor: 100, currency: 'USD' }, created_by: 'u-1', at: new Date() });
    expect(stripe.created[0]).toMatchObject({ provider: 'STRIPE', command_kind: 'CREDIT_GRANT' });
  });
});
