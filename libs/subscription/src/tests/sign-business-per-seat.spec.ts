import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingProviderSeatPort, ProviderSubscriptionState, SeatProrationBehavior } from '../lib/billing/billing-provider.port.js';
import { effectiveProviderPrice } from '../lib/billing/provider-price.js';
import { SeatBillingService, SeatChangeRefusedError, effectivePurchasedSeats } from '../lib/billing/seat-billing.service.js';
import { StripeBillingProvider, stripeSubscriptionState } from '../lib/billing/stripe-billing.provider.js';
import { BillingRefusedError, SubscriptionLifecycleService, seatColumnsAfterProviderState } from '../lib/billing/subscription-lifecycle.service.js';
import { CatalogDraftEditError, applyCatalogDraftEdits, catalogTermsOf } from '../lib/commercial/commercial-catalog.js';
import {
  type PlanVersionContent,
  PlanVersionContentError,
  parsePlanVersionContent,
  planVersionChecksum,
  planVersionContentFromRows,
  planVersionTerms,
  priceUnitOf,
  withPriceUnit,
} from '../lib/plan-version.js';

// Aramo Sign Business Per-Seat Pricing, Implementation Directive v1.0 (LOCKED) §3.1, §3.3, with Amendment
// A1 (No Existing Subscribers): the optional format-1 `price_unit` key, the catalog draft edit, the seat
// columns after a provider state, the seat change (increase prorated, decrease at period end, below usage
// refused, non-SEAT / store / contract refused), the Stripe quantity and the checkout seats.

const contentOf = (o: { key?: string; kind?: string | null; sales_model?: string; list?: number | null } = {}): PlanVersionContent =>
  planVersionContentFromRows({
    plan: {
      key: o.key ?? 'aramo-sign-standard-business-v1',
      product_key: 'sign',
      name: 'Standard Business',
      description: null,
      tenant_kind: o.kind === undefined ? 'BUSINESS' : o.kind,
      sales_model: o.sales_model ?? 'SELF_SERVICE',
      list_price_minor: o.list === undefined ? 1500 : o.list,
      currency: o.list === null ? null : 'USD',
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

const BUSINESS = contentOf();
const PERSONAL = contentOf({ key: 'aramo-sign-standard-personal-v1', kind: 'PERSONAL', list: 1000 });
const ENTERPRISE = contentOf({ key: 'aramo-sign-enterprise-v1', sales_model: 'CONTACT_SALES', list: null });
const reason = (fn: () => unknown): string => {
  try {
    fn();
    return 'ok';
  } catch (e) {
    return e instanceof CatalogDraftEditError ? e.reason : e instanceof PlanVersionContentError ? 'content' : String(e);
  }
};

describe('per-seat content key (§3.1.1)', () => {
  it('a document without price_unit keeps its exact checksum and reads ACCOUNT', () => {
    const raw = JSON.parse(JSON.stringify(BUSINESS)) as unknown;
    const parsed = parsePlanVersionContent(raw);
    expect(parsed).not.toHaveProperty('price_unit');
    expect(planVersionChecksum(parsed)).toBe(planVersionChecksum(raw));
    expect(priceUnitOf(parsed)).toBe('ACCOUNT');
    expect(withPriceUnit(BUSINESS, 'ACCOUNT')).toEqual(BUSINESS);
    expect(planVersionChecksum(withPriceUnit(BUSINESS, 'ACCOUNT'))).toBe(planVersionChecksum(BUSINESS));
  });

  it('SEAT is covered by the checksum and verifies through planVersionTerms', () => {
    const seat = withPriceUnit(BUSINESS, 'SEAT');
    expect(seat.price_unit).toBe('SEAT');
    expect(priceUnitOf(seat)).toBe('SEAT');
    const checksum = planVersionChecksum(seat);
    expect(checksum).not.toBe(planVersionChecksum(BUSINESS));
    expect(planVersionTerms({ id: 'v', content: JSON.parse(JSON.stringify(seat)), content_checksum: checksum }).price_unit).toBe('SEAT');
    expect(() => planVersionTerms({ id: 'v', content: seat, content_checksum: planVersionChecksum(BUSINESS) })).toThrow(PlanVersionContentError);
    expect(withPriceUnit(seat, 'ACCOUNT')).toEqual(BUSINESS);
  });

  it('refuses any other value, and SEAT on a PERSONAL, contract-priced or non-self-service plan', () => {
    for (const v of ['ACCOUNT', 'seat', 1, null, true]) expect(reason(() => parsePlanVersionContent({ ...BUSINESS, price_unit: v }))).toBe('content');
    expect(reason(() => parsePlanVersionContent({ ...PERSONAL, price_unit: 'SEAT' }))).toBe('content');
    expect(reason(() => parsePlanVersionContent({ ...ENTERPRISE, price_unit: 'SEAT' }))).toBe('content');
    const free = contentOf({ sales_model: 'FREE', list: 0 });
    expect(reason(() => parsePlanVersionContent({ ...free, price_unit: 'SEAT' }))).toBe('content');
  });
});

describe('catalog draft price_unit (§3.4.2)', () => {
  it('BUSINESS self-service: SEAT and back to ACCOUNT; the terms carry price_unit and tenant_kind', () => {
    const seat = applyCatalogDraftEdits(BUSINESS, { price_unit: 'SEAT' });
    expect(catalogTermsOf(seat)).toMatchObject({ price_unit: 'SEAT', tenant_kind: 'BUSINESS', list_price_minor: 1500 });
    const both = applyCatalogDraftEdits(BUSINESS, { price_unit: 'SEAT', list_price_minor: 2000 });
    expect(catalogTermsOf(both)).toMatchObject({ price_unit: 'SEAT', list_price_minor: 2000 });
    expect(applyCatalogDraftEdits(seat, { price_unit: 'ACCOUNT' })).toEqual(BUSINESS);
    expect(catalogTermsOf(BUSINESS).price_unit).toBe('ACCOUNT');
  });

  it('PERSONAL and contract plans are refused price_unit_not_applicable; ACCOUNT stays accepted', () => {
    expect(reason(() => applyCatalogDraftEdits(PERSONAL, { price_unit: 'SEAT' }))).toBe('price_unit_not_applicable');
    expect(reason(() => applyCatalogDraftEdits(ENTERPRISE, { price_unit: 'SEAT' }))).toBe('price_unit_not_applicable');
    expect(applyCatalogDraftEdits(PERSONAL, { price_unit: 'ACCOUNT' })).toEqual(PERSONAL);
    expect(reason(() => applyCatalogDraftEdits(BUSINESS, { price_unit: 'PER_USER' as never }))).toBe('term_missing');
    expect(catalogTermsOf(PERSONAL).tenant_kind).toBe('PERSONAL');
  });
});

describe('seat columns after a provider state (§3.3.2, O-2)', () => {
  const end = new Date('2026-12-01T00:00:00Z');
  const next = new Date('2027-01-01T00:00:00Z');
  it('no schedule: the provider quantity is the purchased seats', () => {
    expect(seatColumnsAfterProviderState({ current_period_end: end, seat_quantity: 3, seat_pending_quantity: null, provider_quantity: 5, provider_period_end: end })).toEqual({ seat_quantity: 5, seat_pending_quantity: null });
    expect(seatColumnsAfterProviderState({ current_period_end: null, seat_quantity: null, seat_pending_quantity: null, provider_quantity: 2, provider_period_end: end })).toEqual({ seat_quantity: 2, seat_pending_quantity: null });
  });
  it('a scheduled decrease keeps the paid seats until the period rolls over, then applies', () => {
    expect(seatColumnsAfterProviderState({ current_period_end: end, seat_quantity: 5, seat_pending_quantity: 3, provider_quantity: 3, provider_period_end: end })).toEqual({ seat_quantity: 5, seat_pending_quantity: 3 });
    expect(seatColumnsAfterProviderState({ current_period_end: end, seat_quantity: 5, seat_pending_quantity: 3, provider_quantity: 3, provider_period_end: next })).toEqual({ seat_quantity: 3, seat_pending_quantity: null });
  });
  it('a provider quantity other than the scheduled one replaces both', () => {
    expect(seatColumnsAfterProviderState({ current_period_end: end, seat_quantity: 5, seat_pending_quantity: 3, provider_quantity: 7, provider_period_end: end })).toEqual({ seat_quantity: 7, seat_pending_quantity: null });
  });
  it('the effective limit reads a scheduled decrease once the stored period end has passed', () => {
    const row = { current_period_end: end, seat_quantity: 5, seat_pending_quantity: 3 };
    expect(effectivePurchasedSeats(row, new Date('2026-11-15T00:00:00Z'))).toBe(5);
    expect(effectivePurchasedSeats(row, end)).toBe(3);
    expect(effectivePurchasedSeats({ ...row, seat_quantity: null, seat_pending_quantity: null }, end)).toBeNull();
  });
});

// ---- the seat change -------------------------------------------------------------------------------

interface Row {
  id: string;
  source: string;
  billing_provider: string | null;
  billing_subscription_ref: string | null;
  current_period_end: Date | null;
  seat_quantity: number | null;
  seat_pending_quantity: number | null;
  plan_version: { id: string; content: unknown; content_checksum: string };
}

const SEAT_CONTENT = withPriceUnit(BUSINESS, 'SEAT');
const versionOf = (c: PlanVersionContent) => ({ id: 'v1', content: c, content_checksum: planVersionChecksum(c) });
const PERIOD_END = new Date('2026-12-01T00:00:00Z');
const NOW = new Date('2026-11-10T00:00:00Z');

function harness(over: Partial<Row> = {}) {
  const row: Row = {
    id: 'sub-1',
    source: 'SELF_SERVICE',
    billing_provider: 'STRIPE',
    billing_subscription_ref: 'sub_stripe',
    current_period_end: PERIOD_END,
    seat_quantity: 5,
    seat_pending_quantity: null,
    plan_version: versionOf(SEAT_CONTENT),
    ...over,
  };
  const updates: unknown[] = [];
  const locks: string[] = [];
  const tx = {
    $executeRaw: async (_q: TemplateStringsArray, ...v: unknown[]) => {
      locks.push(String(v[0]));
      return 1;
    },
    tenantSubscription: {
      update: async (a: { data: Partial<Row> }) => {
        updates.push(a.data);
        Object.assign(row, a.data);
        return row;
      },
    },
  };
  const prisma = {
    tenantSubscription: { findFirst: async () => row },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const calls: { quantity: number; proration: SeatProrationBehavior }[] = [];
  const provider: BillingProviderSeatPort = {
    provider: 'STRIPE',
    isConfigured: () => true,
    updateSubscriptionQuantity: async (_ref, quantity, proration) => {
      calls.push({ quantity, proration });
      return {} as ProviderSubscriptionState;
    },
  };
  return { svc: new SeatBillingService(prisma as never, provider), row, updates, calls, locks };
}

const refusal = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e: unknown) => (e instanceof SeatChangeRefusedError ? `${e.reason}${'used' in e.details ? ` used=${String(e.details['used'])}` : ''}` : String(e)),
  );

describe('SeatBillingService (§3.3.3, O-2)', () => {
  const input = { tenant_id: 't-1', product_key: 'sign' as const, at: NOW };

  it('seatState / seatLimit: SEAT reads the purchased seats; ACCOUNT has no limit', async () => {
    const h = harness();
    expect(await h.svc.seatState('t-1', 'sign', NOW)).toEqual({ price_unit: 'SEAT', purchased: 5, pending_purchased: null, changeable: true });
    expect(await h.svc.seatLimit('t-1', 'sign', NOW)).toBe(5);
    const a = harness({ plan_version: versionOf(BUSINESS), seat_quantity: null });
    expect(await a.svc.seatState('t-1', 'sign', NOW)).toEqual({ price_unit: 'ACCOUNT', purchased: null, pending_purchased: null, changeable: false });
    expect(await a.svc.seatLimit('t-1', 'sign', NOW)).toBeNull();
    const pending = harness({ seat_pending_quantity: 3 });
    expect(await pending.svc.seatState('t-1', 'sign', NOW)).toMatchObject({ purchased: 5, pending_purchased: 3 });
    expect(await pending.svc.seatState('t-1', 'sign', PERIOD_END)).toMatchObject({ purchased: 3, pending_purchased: null });
  });

  it('increase: prorated at the provider, effective now, under the billing lock', async () => {
    const h = harness();
    expect(await h.svc.changeSeats({ ...input, seats: 7, used: 4 })).toEqual({ purchased: 7, used: 4, pending_purchased: null, effective: 'NOW' });
    expect(h.calls).toEqual([{ quantity: 7, proration: 'create_prorations' }]);
    expect(h.updates).toEqual([{ seat_quantity: 7, seat_pending_quantity: null }]);
    expect(h.locks).toEqual(['billing:t-1']);
  });

  it('decrease: no proration (no refund), the paid seats kept until period end', async () => {
    const h = harness();
    expect(await h.svc.changeSeats({ ...input, seats: 3, used: 3 })).toEqual({ purchased: 5, used: 3, pending_purchased: 3, effective: 'PERIOD_END' });
    expect(h.calls).toEqual([{ quantity: 3, proration: 'none' }]);
    expect(h.updates).toEqual([{ seat_quantity: 5, seat_pending_quantity: 3 }]);
  });

  it('an increase while a decrease is scheduled restores the paid quantity first, then prorates only above it', async () => {
    const h = harness({ seat_pending_quantity: 3 });
    expect(await h.svc.changeSeats({ ...input, seats: 6, used: 2 })).toMatchObject({ purchased: 6, pending_purchased: null, effective: 'NOW' });
    expect(h.calls).toEqual([
      { quantity: 5, proration: 'none' },
      { quantity: 6, proration: 'create_prorations' },
    ]);
    const keep = harness({ seat_pending_quantity: 3 });
    expect(await keep.svc.changeSeats({ ...input, seats: 5, used: 2 })).toMatchObject({ purchased: 5, pending_purchased: null, effective: 'NOW' });
    expect(keep.calls).toEqual([{ quantity: 5, proration: 'none' }]);
  });

  it('refuses below the seats in use, the current count, a non-SEAT, store, contract or missing subscription', async () => {
    const h = harness();
    expect(await refusal(h.svc.changeSeats({ ...input, seats: 2, used: 3 }))).toBe('seats_below_usage used=3');
    expect(await refusal(h.svc.changeSeats({ ...input, seats: 5, used: 3 }))).toBe('seats_unchanged');
    expect(await refusal(harness({ seat_pending_quantity: 3 }).svc.changeSeats({ ...input, seats: 3, used: 1 }))).toBe('seats_unchanged');
    expect(await refusal(harness({ plan_version: versionOf(BUSINESS), seat_quantity: null }).svc.changeSeats({ ...input, seats: 2, used: 1 }))).toBe('seats_not_applicable');
    expect(await refusal(harness({ billing_provider: 'APP_STORE', billing_subscription_ref: null }).svc.changeSeats({ ...input, seats: 2, used: 1 }))).toBe('seats_not_applicable');
    expect(await refusal(harness({ source: 'MANUAL', billing_provider: null, billing_subscription_ref: null }).svc.changeSeats({ ...input, seats: 2, used: 1 }))).toBe('seats_not_applicable');
    expect(await refusal(harness().svc.changeSeats({ ...input, seats: 0, used: 0 }))).toBe('seats_not_applicable');
    const none = new SeatBillingService({ tenantSubscription: { findFirst: async () => null } } as never, undefined);
    expect(await refusal(none.changeSeats({ ...input, seats: 2, used: 1 }))).toBe('seats_not_applicable');
    expect(h.calls).toEqual([]);
  });
});

// ---- Stripe ------------------------------------------------------------------------------------------

describe('Stripe seat quantity (§3.3.1-§3.3.3)', () => {
  const env = { ...process.env };
  let requests: { method: string; path: string; body: URLSearchParams; key: string | undefined }[];
  beforeEach(() => {
    process.env['STRIPE_SECRET_KEY'] = 'sk_test_seats';
    process.env['STRIPE_API_BASE'] = 'https://stripe.seats.test';
    requests = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const u = new URL(url);
        const headers = (init.headers as Record<string, string>) ?? {};
        requests.push({ method: String(init.method), path: u.pathname, body: new URLSearchParams(typeof init.body === 'string' ? init.body : ''), key: headers['idempotency-key'] });
        return new Response(
          JSON.stringify({ id: 'sub_1', url: 'https://checkout.test/s', status: 'active', items: { data: [{ id: 'si_1', quantity: 4, price: { id: 'price_seat' } }] }, current_period_start: 1, current_period_end: 2 }),
          { status: 200 },
        );
      }),
    );
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it('the subscription state reads the first item and its quantity', () => {
    const s = stripeSubscriptionState({ id: 'sub_1', status: 'active', items: { data: [{ id: 'si_1', quantity: 3, price: { id: 'p' } }] } });
    expect(s).toMatchObject({ item_ref: 'si_1', quantity: 3, price_ref: 'p' });
    expect(stripeSubscriptionState({ id: 'sub_1', status: 'active', items: { data: [] } })).toMatchObject({ item_ref: null, quantity: null });
  });

  it('checkout sends the seats as the line-item quantity (1 when absent)', async () => {
    const p = new StripeBillingProvider();
    const req = { intent_id: 'i-1', tenant_id: 't-1', user_id: 'u-1', user_email: 'o@acme.test', price_ref: 'price_seat', account_ref: 'cus_1', success_url: 'https://e/ok', cancel_url: 'https://e/no' };
    await p.createCheckoutSession({ ...req, quantity: 4 });
    await p.createCheckoutSession(req);
    expect(requests.map((r) => r.body.get('line_items[0][quantity]'))).toEqual(['4', '1']);
  });

  it('a quantity update names the item, the quantity and the proration, with the idempotency key', async () => {
    const p = new StripeBillingProvider();
    const after = await p.updateSubscriptionQuantity('sub_1', 6, 'create_prorations', 'k-1');
    expect(after.quantity).toBe(4);
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /v1/subscriptions/sub_1', 'POST /v1/subscriptions/sub_1', 'GET /v1/subscriptions/sub_1']);
    const post = requests[1] as (typeof requests)[number];
    expect(post.body.get('items[0][id]')).toBe('si_1');
    expect(post.body.get('items[0][quantity]')).toBe('6');
    expect(post.body.get('proration_behavior')).toBe('create_prorations');
    expect(post.key).toBe('k-1');
    await p.updateSubscriptionQuantity('sub_1', 2, 'none', 'k-2');
    expect((requests[4] as (typeof requests)[number]).body.get('proration_behavior')).toBe('none');
    await expect(p.updateSubscriptionQuantity('sub_1', 0, 'none', 'k-3')).rejects.toThrow(/positive integer/);
  });
});

// ---- checkout seats ----------------------------------------------------------------------------------

function checkoutHarness(content: PlanVersionContent, pinned: string | null = 'price_seat') {
  const intents: Record<string, unknown>[] = [];
  const sessions: Record<string, unknown>[] = [];
  const plan = { id: 'plan-b', key: content.plan.key, product_key: 'sign', sellable: true, status: 'ACTIVE', sales_model: 'SELF_SERVICE', tenant_kind: 'BUSINESS' };
  const version = versionOf(content);
  const tx = {
    $executeRaw: async () => 1,
    tenantSubscription: { findFirst: async () => null },
    checkoutIntent: {
      create: async (a: { data: Record<string, unknown> }) => {
        intents.push(a.data);
        return a.data;
      },
    },
  };
  const prisma = {
    plan: { findUnique: async () => plan },
    planVersion: { findFirst: async () => version },
    planVersionPrice: { findUnique: async () => (pinned === null ? null : { provider_price_ref: pinned }) },
    tenantSubscription: { findFirst: async () => null },
    tenantBillingAccount: { findUnique: async () => null, upsert: async () => ({}) },
    checkoutIntent: { update: async () => ({}) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const billing = {
    provider: 'STRIPE',
    isConfigured: () => true,
    mode: () => 'test',
    upsertBillingAccount: async () => 'cus_1',
    createCheckoutSession: async (r: Record<string, unknown>) => {
      sessions.push(r);
      return { session_ref: 'cs_1', url: 'https://checkout.test/s' };
    },
  };
  const orgProfile = {
    eligibleProfile: async () => ({ profile: { legal_name: 'Acme', billing_email: 'b@acme.test', address: { line1: '1', line2: null, city: 'A', state: 'TX', postal_code: '78701', country: 'US' } } }),
    lockRegion: async () => undefined,
    domainAuthoritative: async () => true,
  };
  const svc = new SubscriptionLifecycleService(prisma as never, {} as never, billing as never, {} as never, undefined, [], orgProfile as never);
  const start = (seats?: number) =>
    svc.startCheckout({ tenant_id: 't-1', product_key: 'sign', user_id: 'u-1', user_email: 'o@acme.test', plan_key: content.plan.key, success_url: 'https://e/ok', cancel_url: 'https://e/no', ...(seats !== undefined ? { seats } : {}) });
  return { start, intents, sessions };
}

const billingReason = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => (e instanceof BillingRefusedError ? e.reason : String(e)));

describe('checkout seats (§3.3.1)', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('a SEAT version: the seats become the line quantity and the intent seat_quantity (default 1)', async () => {
    const h = checkoutHarness(SEAT_CONTENT);
    await h.start(4);
    await h.start();
    expect(h.sessions.map((s) => s['quantity'])).toEqual([4, 1]);
    expect(h.intents.map((i) => i['seat_quantity'])).toEqual([4, 1]);
  });

  it('a per-account version: no quantity, null seat_quantity, and `seats` refused SEATS_NOT_APPLICABLE', async () => {
    const h = checkoutHarness(BUSINESS);
    await h.start();
    expect(h.sessions[0]).not.toHaveProperty('quantity');
    expect(h.intents[0]?.['seat_quantity']).toBeNull();
    expect(await billingReason(h.start(2))).toBe('SEATS_NOT_APPLICABLE');
    expect(await billingReason(checkoutHarness(SEAT_CONTENT).start(1001))).toBe('SEATS_NOT_APPLICABLE');
  });

  it('A1-5: a SEAT version sells only on its pin — the env per-account price is ignored', async () => {
    const env = new Map([['aramo-sign-standard-business-v1', 'price_env_account']]);
    const db = (pin: string | null) => ({ planVersionPrice: { findUnique: async () => (pin === null ? null : { provider_price_ref: pin }) } }) as never;
    const key = 'aramo-sign-standard-business-v1';
    expect(await effectiveProviderPrice(db(null), 'v-1', key, env, 'SEAT')).toEqual({ ok: false, reason: 'NO_PRICE' });
    expect(await effectiveProviderPrice(db('price_seat'), 'v-1', key, env, 'SEAT')).toEqual({ ok: true, ref: 'price_seat', source: 'PIN' });
    // A per-account version keeps the cutover fallback.
    expect(await effectiveProviderPrice(db(null), 'v-1', key, env)).toEqual({ ok: true, ref: 'price_env_account', source: 'ENV' });
  });

  it('A1-5: a SEAT version without a resolvable provider price fails closed (BILLING_UNAVAILABLE), before any provider call', async () => {
    // Even with an env (per-account) price for the plan: a per-seat version is pin-only.
    process.env['STRIPE_PLAN_PRICES'] = 'aramo-sign-standard-business-v1=price_env_account';
    const h = checkoutHarness(SEAT_CONTENT, null);
    expect(await billingReason(h.start(3))).toBe('BILLING_UNAVAILABLE');
    expect(h.sessions).toEqual([]);
    expect(h.intents).toEqual([]);
  });
});

describe('plans read price_unit (§3.3.4)', () => {
  it('each catalog plan carries its PUBLISHED version price unit', async () => {
    const rows = [SEAT_CONTENT, PERSONAL].map((c, i) => ({
      id: `plan-${String(i)}`,
      key: c.plan.key,
      name: c.plan.name,
      description: null,
      tenant_kind: c.plan.tenant_kind,
      sales_model: 'SELF_SERVICE',
      status: 'ACTIVE',
      sellable: true,
      activation_note: null,
      versions: [versionOf(c)],
    }));
    const prisma = { plan: { findMany: async () => rows }, planVersionPrice: { findUnique: async () => null } };
    const svc = new SubscriptionLifecycleService(prisma as never, {} as never, { provider: 'STRIPE', isConfigured: () => true } as never, {} as never);
    const plans = await svc.catalog('sign');
    expect(plans.map((p) => [p.key, p.price_unit])).toEqual([
      ['aramo-sign-standard-business-v1', 'SEAT'],
      ['aramo-sign-standard-personal-v1', 'ACCOUNT'],
    ]);
  });
});

// ---- the webhook: provider quantity → TenantSubscription.seat_quantity (§3.3.2) ---------------------

function webhookHarness(o: { existing: Record<string, unknown> | null; content: PlanVersionContent; intentSeats?: number | null }) {
  const version = versionOf(o.content);
  const created: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async () => 1,
    tenantSubscription: {
      findFirst: async (a: { where: Record<string, unknown> }) => ('billing_subscription_ref' in a.where ? o.existing : null),
      update: async (a: { data: Record<string, unknown> }) => {
        updated.push(a.data);
        return a.data;
      },
      create: async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return a.data;
      },
    },
    billingReconciliationFlag: { updateMany: async () => ({ count: 0 }) },
    planVersion: { findUniqueOrThrow: async () => version, findFirst: async () => version },
    plan: { findUniqueOrThrow: async () => ({ id: 'plan-b', key: o.content.plan.key, product_key: 'sign' }) },
    checkoutIntent: { update: async () => ({}) },
  };
  const intent = { id: 'i-1', tenant_id: 't-1', user_id: 'u-1', plan_id: 'plan-b', status: 'CREATED', seat_quantity: o.intentSeats ?? null, plan: { key: o.content.plan.key, product_key: 'sign', tenant_kind: 'BUSINESS' } };
  const prisma = {
    tenantSubscription: { findFirst: async () => o.existing },
    checkoutIntent: { findUnique: async () => intent },
    plan: { findUnique: async () => ({ tenant_kind: 'BUSINESS' }) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const orgProfile = { domainAuthoritative: async () => true };
  const svc = new SubscriptionLifecycleService(prisma as never, {} as never, { provider: 'STRIPE', isConfigured: () => true } as never, {} as never, undefined, [], orgProfile as never);
  const state = (quantity: number | null, period_end = PERIOD_END): ProviderSubscriptionState => ({
    provider: 'STRIPE',
    subscription_ref: 'sub_1',
    account_ref: 'acct_1',
    provider_status: 'active',
    current_period_start: new Date('2026-11-01T00:00:00Z'),
    current_period_end: period_end,
    cancel_at_period_end: false,
    price_ref: null,
    tenant_id: 't-1',
    intent_id: 'i-1',
    account_country: 'US',
    item_ref: 'si_1',
    quantity,
  });
  return { svc, state, created, updated };
}

const existingRow = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  tenant_id: 't-1',
  plan_id: 'plan-b',
  plan_version_id: 'v1',
  product_key: 'sign',
  status: 'ACTIVE',
  grace_until: null,
  ended_at: null,
  activated_by: 'u-1',
  commitment_end: null,
  current_period_end: PERIOD_END,
  seat_quantity: 3,
  seat_pending_quantity: null,
  ...over,
});

describe('webhook seat quantity (§3.3.2)', () => {
  it('a new per-seat subscription opens with the provider quantity (else the checkout seats)', async () => {
    const h = webhookHarness({ existing: null, content: SEAT_CONTENT, intentSeats: 2 });
    expect((await h.svc.applyProviderState(h.state(4), 'sign', NOW)).outcome).toBe('APPLIED');
    expect(h.created[0]?.['seat_quantity']).toBe(4);
    const fallback = webhookHarness({ existing: null, content: SEAT_CONTENT, intentSeats: 2 });
    await fallback.svc.applyProviderState(fallback.state(null), 'sign', NOW);
    expect(fallback.created[0]?.['seat_quantity']).toBe(2);
  });

  it('a per-account subscription carries no seat quantity', async () => {
    const h = webhookHarness({ existing: null, content: BUSINESS });
    await h.svc.applyProviderState(h.state(1), 'sign', NOW);
    expect(h.created[0]?.['seat_quantity']).toBeNull();
    const u = webhookHarness({ existing: existingRow({ seat_quantity: null }), content: BUSINESS });
    await u.svc.applyProviderState(u.state(1), 'sign', NOW);
    expect(u.updated[0]).toMatchObject({ seat_quantity: null, seat_pending_quantity: null });
  });

  it('an update writes the provider quantity; a scheduled decrease waits for the period to roll over', async () => {
    const h = webhookHarness({ existing: existingRow(), content: SEAT_CONTENT });
    await h.svc.applyProviderState(h.state(6), 'sign', NOW);
    expect(h.updated[0]).toMatchObject({ seat_quantity: 6, seat_pending_quantity: null });
    const pending = webhookHarness({ existing: existingRow({ seat_quantity: 5, seat_pending_quantity: 3 }), content: SEAT_CONTENT });
    await pending.svc.applyProviderState(pending.state(3), 'sign', NOW);
    expect(pending.updated[0]).toMatchObject({ seat_quantity: 5, seat_pending_quantity: 3 });
    const rolled = webhookHarness({ existing: existingRow({ seat_quantity: 5, seat_pending_quantity: 3 }), content: SEAT_CONTENT });
    await rolled.svc.applyProviderState(rolled.state(3, new Date('2027-01-01T00:00:00Z')), 'sign', NOW);
    expect(rolled.updated[0]).toMatchObject({ seat_quantity: 3, seat_pending_quantity: null });
  });
});
