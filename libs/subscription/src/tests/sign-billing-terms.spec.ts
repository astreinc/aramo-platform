import { describe, expect, it, vi } from 'vitest';

import type { BillingProviderPort } from '../lib/billing/billing-provider.port.js';
import { postCommitmentMonthlyPrice } from '../lib/billing/renewal-notice.js';
import {
  BillingRefusedError,
  businessCheckoutDisclosure,
  checkoutDisclosureTerms,
  personalCheckoutDisclosure,
  SubscriptionLifecycleService,
  subscriptionCommitmentMonths,
  subscriptionTerm,
  subscriptionTermPrice,
  termSwitchRefusal,
} from '../lib/billing/subscription-lifecycle.service.js';
import { StripeCatalogWriter, lookupKey } from '../lib/billing/sync/stripe-catalog.writer.js';
import { rolloverVersion, termRolloverDue, type TermRolloverRow } from '../lib/billing/term-rollover.service.js';
import { applyAnnualCommitPriceEdit, applyCatalogDraftEdits, CatalogDraftEditError, catalogTermsOf } from '../lib/commercial/commercial-catalog.js';
import {
  billingTermOf,
  defaultBillingTerm,
  hasExplicitTerms,
  type PlanVersionContent,
  PlanVersionContentError,
  parsePlanVersionContent,
  planVersionChecksum,
  planVersionContentFromRows,
  versionTerms,
  withBillingTerms,
} from '../lib/plan-version.js';

// Aramo Sign Monthly and Annual-Commitment Pricing Directive v1.0 (LOCKED 2026-11-15) §3 items 1-4: the
// version's billing terms, the Stripe price per term, checkout by term, the commitment from the term, the
// switching rule (Q4) and the post-commitment MONTHLY price (Q2). Existing versions read as ONE term.

const base = (o: { kind?: 'PERSONAL' | 'BUSINESS'; price?: number | null; commitment?: number | null; sales_model?: string } = {}): PlanVersionContent =>
  planVersionContentFromRows({
    plan: {
      key: o.kind === 'BUSINESS' ? 'aramo-sign-standard-business-v1' : 'aramo-sign-standard-personal-v1',
      product_key: 'sign',
      name: 'Standard',
      description: null,
      tenant_kind: o.kind ?? 'PERSONAL',
      sales_model: o.sales_model ?? 'SELF_SERVICE',
      list_price_minor: o.price === undefined ? 1000 : o.price,
      currency: o.price === null ? null : 'USD',
      reference_price_minor: null,
      reference_price_substantiated: false,
      billing_interval: o.price === null ? null : 'MONTH',
      commitment_months: o.commitment === undefined ? 12 : o.commitment,
      eligibility: null,
      support_tier: 'BASIC',
    },
    allowances: [{ allowance_key: 'sign.envelopes', included_quantity: null, unlimited: true, period: 'MONTHLY' }],
    allowance_windows: [],
    capacities: [],
    features: [],
  });

const LEGACY_12 = base(); // today's Personal Standard shape: $10, 12-month commitment, no terms key
const LEGACY_NONE = base({ commitment: null });
const TWO = withBillingTerms(LEGACY_12, [
  { term: 'MONTHLY', list_price_minor: 1200, commitment_months: null },
  { term: 'ANNUAL_COMMIT', list_price_minor: 1000, commitment_months: 12 },
]);
const versionOf = (c: PlanVersionContent, id = 'v1') => ({ id, content: c, content_checksum: planVersionChecksum(c) });

describe('§3.1 catalog — the version carries terms; an existing version reads as ONE derived term', () => {
  it('a version without terms keeps its exact content and checksum, and derives one term', () => {
    expect('terms' in LEGACY_12).toBe(false);
    expect(planVersionChecksum(parsePlanVersionContent(JSON.parse(JSON.stringify(LEGACY_12))))).toBe(planVersionChecksum(LEGACY_12));
    expect(hasExplicitTerms(LEGACY_12)).toBe(false);
    expect(versionTerms(LEGACY_12)).toEqual([{ term: 'ANNUAL_COMMIT', list_price_minor: 1000, commitment_months: 12 }]);
    expect(versionTerms(LEGACY_NONE)).toEqual([{ term: 'MONTHLY', list_price_minor: 1000, commitment_months: null }]);
    expect(versionTerms(base({ price: null, commitment: null, sales_model: 'CONTACT_SALES' }))).toEqual([]);
    expect(defaultBillingTerm(LEGACY_12)?.term).toBe('ANNUAL_COMMIT');
  });

  it('withBillingTerms: MONTHLY first, the plan price follows MONTHLY and the plan commitment clears; null removes the key', () => {
    expect(TWO.terms).toEqual([
      { term: 'MONTHLY', list_price_minor: 1200, commitment_months: null },
      { term: 'ANNUAL_COMMIT', list_price_minor: 1000, commitment_months: 12 },
    ]);
    expect(TWO.plan.list_price_minor).toBe(1200);
    expect(TWO.plan.commitment_months).toBeNull();
    expect(defaultBillingTerm(TWO)?.term).toBe('MONTHLY');
    expect(billingTermOf(TWO, 'ANNUAL_COMMIT')?.list_price_minor).toBe(1000);
    expect('terms' in withBillingTerms(TWO, null)).toBe(false);
    // Order-insensitive input, canonical output.
    expect(withBillingTerms(LEGACY_12, [...(TWO.terms ?? [])].reverse()).terms).toEqual(TWO.terms);
  });

  it('the strict parser refuses every malformed terms document', () => {
    const bad = (terms: unknown, plan: Partial<PlanVersionContent['plan']> = {}) => () =>
      parsePlanVersionContent({ ...TWO, plan: { ...TWO.plan, ...plan }, terms });
    expect(bad([])).toThrow(PlanVersionContentError);
    expect(bad([{ term: 'ANNUAL_COMMIT', list_price_minor: 1000, commitment_months: 12 }])).toThrow(/start with the MONTHLY/);
    expect(bad([{ term: 'MONTHLY', list_price_minor: 1200, commitment_months: null }, { term: 'MONTHLY', list_price_minor: 1200, commitment_months: null }])).toThrow(/repeat/);
    expect(bad([{ term: 'MONTHLY', list_price_minor: 1200, commitment_months: 12 }])).toThrow(/no commitment/);
    expect(bad([{ term: 'MONTHLY', list_price_minor: 1200, commitment_months: null }, { term: 'ANNUAL_COMMIT', list_price_minor: 1000, commitment_months: 6 }])).toThrow(/12-month/);
    expect(bad([{ term: 'MONTHLY', list_price_minor: 999, commitment_months: null }])).toThrow(/equal the MONTHLY/);
    expect(bad([{ term: 'MONTHLY', list_price_minor: 1200, commitment_months: null }], { commitment_months: 12 })).toThrow(/commitment_months must be null/);
    expect(bad([{ term: 'MONTHLY', list_price_minor: 1200, commitment_months: null, extra: 1 }])).toThrow(/keys/);
    expect(bad([{ term: 'WEEKLY', list_price_minor: 1200, commitment_months: null }])).toThrow(/MONTHLY or ANNUAL_COMMIT/);
    expect(bad([{ term: 'MONTHLY', list_price_minor: 0, commitment_months: null }], { list_price_minor: 0 })).toThrow(/list_price_minor/);
    expect(() => parsePlanVersionContent({ ...base({ price: null, commitment: null, sales_model: 'CONTACT_SALES' }), terms: [{ term: 'MONTHLY', list_price_minor: 1, commitment_months: null }] })).toThrow(/contract-priced|self-service/);
  });
});

describe('§3.1 console draft edits — the optional annual price', () => {
  it('setting the annual price gives explicit terms (MONTHLY at the list price, no commitment); null keeps MONTHLY only', () => {
    const two = applyAnnualCommitPriceEdit(LEGACY_12, 800);
    expect(two.terms).toEqual([
      { term: 'MONTHLY', list_price_minor: 1000, commitment_months: null },
      { term: 'ANNUAL_COMMIT', list_price_minor: 800, commitment_months: 12 },
    ]);
    expect(catalogTermsOf(two)).toMatchObject({ explicit_terms: true, billing_terms: two.terms });
    expect(applyAnnualCommitPriceEdit(two, null).terms).toEqual([{ term: 'MONTHLY', list_price_minor: 1000, commitment_months: null }]);
    // Removing on a single-term version changes nothing.
    expect(applyAnnualCommitPriceEdit(LEGACY_12, null)).toBe(LEGACY_12);
  });

  it('a list-price edit moves the MONTHLY term with it; bad prices and contract-priced plans are refused', () => {
    const edited = applyCatalogDraftEdits(TWO, { list_price_minor: 1500 });
    expect(edited.plan.list_price_minor).toBe(1500);
    expect(billingTermOf(edited, 'MONTHLY')?.list_price_minor).toBe(1500);
    expect(billingTermOf(edited, 'ANNUAL_COMMIT')?.list_price_minor).toBe(1000);
    expect(applyCatalogDraftEdits(LEGACY_12, { annual_commit_price_minor: 900 }).terms?.length).toBe(2);
    expect(() => applyAnnualCommitPriceEdit(LEGACY_12, 0)).toThrow(CatalogDraftEditError);
    expect(() => applyAnnualCommitPriceEdit(LEGACY_12, 1.5)).toThrow(CatalogDraftEditError);
    expect(() => applyAnnualCommitPriceEdit(base({ price: null, commitment: null, sales_model: 'CONTACT_SALES' }), 500)).toThrow(/contract-priced/);
    expect(() => applyCatalogDraftEdits(TWO, { list_price_minor: 0 })).toThrow(CatalogDraftEditError);
  });
});

describe('§3.2 Stripe — one monthly price per term; the legacy / MONTHLY lookup key is unchanged', () => {
  it('lookupKey: legacy slot and MONTHLY keep the version key, ANNUAL_COMMIT adds a suffix', () => {
    expect(lookupKey('v4', 'MONTH')).toBe('aramo_v4_month');
    expect(lookupKey('v4', 'MONTH', null)).toBe('aramo_v4_month');
    expect(lookupKey('v4', 'MONTH', 'MONTHLY')).toBe('aramo_v4_month');
    expect(lookupKey('v4', 'MONTH', 'ANNUAL_COMMIT')).toBe('aramo_v4_month_annual_commit');
  });

  const target = (web_terms?: { term: 'MONTHLY' | 'ANNUAL_COMMIT'; amount_minor: number; pin_term: 'MONTHLY' | 'ANNUAL_COMMIT' | null }[]) => ({
    provider: 'STRIPE' as const,
    interval: 'MONTH' as const,
    product_id: 'aramo_sign_personal_standard',
    plan_id: 'p1',
    plan_key: 'aramo-sign-standard-personal-v1',
    display_name: 'Standard',
    description: '',
    stop_countries: [],
    plan_version_id: 'v5',
    version_number: 5,
    prices: [{ country: 'US', currency: 'USD', amount_minor: 1200 }],
    known_external_ref: 'aramo_sign_personal_standard',
    review_screenshot: null,
    ...(web_terms !== undefined ? { web_terms } : {}),
  });

  function fakeStripe() {
    const posted: { path: string; body: string }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('https://stripe.test', '');
      if (init?.method === 'GET' && path.startsWith('/v1/products/')) return new Response(JSON.stringify({ id: 'aramo_sign_personal_standard', name: 'Standard', description: '', active: true }), { status: 200 });
      if (init?.method === 'GET' && path.startsWith('/v1/prices')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
      posted.push({ path, body: String(init?.body ?? '') });
      const lookup = new URLSearchParams(String(init?.body ?? '')).get('lookup_key') ?? '';
      return new Response(JSON.stringify({ id: `price_${lookup}` }), { status: 200 });
    });
    const writer = new StripeCatalogWriter(fetchImpl as never, { key: () => 'sk_test_x', base: () => 'https://stripe.test' });
    return { writer, posted };
  }

  it('a two-term version: two prices (MONTHLY on the version key, ANNUAL_COMMIT on its own), each pinned to its term', async () => {
    const { writer, posted } = fakeStripe();
    const out = await writer.sync(target([
      { term: 'MONTHLY', amount_minor: 1200, pin_term: 'MONTHLY' },
      { term: 'ANNUAL_COMMIT', amount_minor: 1000, pin_term: 'ANNUAL_COMMIT' },
    ]));
    const prices = posted.filter((p) => p.path === '/v1/prices').map((p) => Object.fromEntries(new URLSearchParams(p.body)));
    expect(prices.map((p) => [p['lookup_key'], p['unit_amount'], p['recurring[interval]']])).toEqual([
      ['aramo_v5_month', '1200', 'month'],
      ['aramo_v5_month_annual_commit', '1000', 'month'],
    ]);
    expect(out.external_price_ref).toBe('price_aramo_v5_month');
    expect(out.term_price_refs).toEqual([
      { pin_term: 'MONTHLY', external_price_ref: 'price_aramo_v5_month' },
      { pin_term: 'ANNUAL_COMMIT', external_price_ref: 'price_aramo_v5_month_annual_commit' },
    ]);
  });

  it('a legacy target (no web_terms): one price on the version key, no term refs (exactly as before)', async () => {
    const { writer, posted } = fakeStripe();
    const out = await writer.sync(target());
    expect(posted.filter((p) => p.path === '/v1/prices').map((p) => new URLSearchParams(p.body).get('lookup_key'))).toEqual(['aramo_v5_month']);
    expect(out.term_price_refs).toBeUndefined();
  });
});

describe('§3.3 / §3.4 — the subscription term, its commitment and the switching rule', () => {
  it('commitment and term of a row: a term row by its term; a legacy row by its version; a monthly store row none', () => {
    expect(subscriptionCommitmentMonths({ term: 'MONTHLY' }, TWO)).toBeNull();
    expect(subscriptionCommitmentMonths({ term: 'ANNUAL_COMMIT' }, TWO)).toBe(12);
    expect(subscriptionCommitmentMonths({ term: null }, LEGACY_12)).toBe(12);
    expect(subscriptionCommitmentMonths({ term: null, store_interval: 'MONTH' }, LEGACY_12)).toBeNull();
    expect(subscriptionTerm({ term: null }, LEGACY_12)).toBe('ANNUAL_COMMIT');
    expect(subscriptionTerm({ term: null, store_interval: 'MONTH' }, LEGACY_12)).toBe('MONTHLY');
    expect(subscriptionTermPrice({ term: 'ANNUAL_COMMIT' }, TWO)).toBe(1000);
    expect(subscriptionTermPrice({ term: 'MONTHLY' }, TWO)).toBe(1200);
    expect(subscriptionTermPrice({ term: null }, LEGACY_12)).toBe(1000);
  });

  it('Q4: MONTHLY → ANNUAL_COMMIT anytime; ANNUAL_COMMIT → MONTHLY only at commitment end', () => {
    const row = (o: Partial<Parameters<typeof termSwitchRefusal>[0]>) => ({ term: 'MONTHLY', source: 'SELF_SERVICE', billing_provider: 'STRIPE', commitment_end: null, current_period_end: new Date('2027-01-01'), ...o });
    expect(termSwitchRefusal(row({}), TWO, 'ANNUAL_COMMIT')).toBeNull();
    expect(termSwitchRefusal(row({}), TWO, 'MONTHLY')).toBe('term_unchanged');
    const committed = row({ term: 'ANNUAL_COMMIT', commitment_end: new Date('2027-06-01'), current_period_end: new Date('2027-01-01') });
    expect(termSwitchRefusal(committed, TWO, 'MONTHLY')).toBe('commitment_in_force');
    expect(termSwitchRefusal({ ...committed, current_period_end: new Date('2027-06-01') }, TWO, 'MONTHLY')).toBeNull();
    expect(termSwitchRefusal(row({}), withBillingTerms(TWO, [{ term: 'MONTHLY', list_price_minor: 1200, commitment_months: null }]), 'ANNUAL_COMMIT')).toBe('term_not_available');
    expect(termSwitchRefusal(row({ term: null }), LEGACY_12, 'MONTHLY')).toBe('term_switch_not_supported');
    expect(termSwitchRefusal(row({ billing_provider: 'APP_STORE' }), TWO, 'ANNUAL_COMMIT')).toBe('term_switch_not_supported');
    expect(termSwitchRefusal(row({ billing_provider: 'RAZORPAY' }), TWO, 'ANNUAL_COMMIT')).toBe('term_switch_not_supported');
  });

  it('Q2: the rollover is due in the last commitment period only; it targets the current version with explicit terms, else its own', () => {
    const r: TermRolloverRow = {
      id: 's1', plan_id: 'p1', plan_version_id: 'v5', term: 'ANNUAL_COMMIT', source: 'SELF_SERVICE', billing_provider: 'STRIPE', billing_subscription_ref: 'sub_1',
      cancel_at_period_end: false, commitment_end: new Date('2027-11-15'), current_period_end: new Date('2027-11-15'),
    };
    expect(termRolloverDue(r)).toBe(true);
    expect(termRolloverDue({ ...r, current_period_end: new Date('2027-10-15') })).toBe(false);
    expect(termRolloverDue({ ...r, cancel_at_period_end: true })).toBe(false);
    expect(termRolloverDue({ ...r, term: null })).toBe(false);
    expect(termRolloverDue({ ...r, term: 'MONTHLY' })).toBe(false);
    expect(termRolloverDue({ ...r, billing_provider: 'APP_STORE' })).toBe(false);
    const NEWER = withBillingTerms(LEGACY_12, [{ term: 'MONTHLY', list_price_minor: 1300, commitment_months: null }]);
    expect(rolloverVersion(versionOf(TWO, 'v5'), versionOf(NEWER, 'v6'))?.row.id).toBe('v6');
    expect(rolloverVersion(versionOf(TWO, 'v5'), versionOf(LEGACY_12, 'v6'))?.row.id).toBe('v5');
    expect(rolloverVersion(versionOf(LEGACY_12, 'v4'), null)).toBeNull();
    expect(postCommitmentMonthlyPrice(TWO, NEWER)).toBe(1300);
    expect(postCommitmentMonthlyPrice(TWO, LEGACY_12)).toBe(1200);
    expect(postCommitmentMonthlyPrice(LEGACY_12, null)).toBeNull();
  });
});

describe('§3.5 — the checkout disclosure states the chosen term', () => {
  it('MONTHLY: no commitment, cancel anytime; ANNUAL_COMMIT: 12 months, then the MONTHLY price; legacy unchanged', () => {
    const monthly = personalCheckoutDisclosure(checkoutDisclosureTerms(TWO, billingTermOf(TWO, 'MONTHLY')!, true)) as string;
    expect(monthly).toContain('$12.00 per month');
    expect(monthly).toContain('cancel online any time');
    expect(monthly).not.toContain('commitment');
    const annual = personalCheckoutDisclosure(checkoutDisclosureTerms(TWO, billingTermOf(TWO, 'ANNUAL_COMMIT')!, true)) as string;
    expect(annual).toContain('$10.00 per month');
    expect(annual).toContain('12-month commitment');
    expect(annual).toContain('continues month to month at $12.00 per month');
    expect(annual.length).toBeLessThanOrEqual(1200);
    // A version without explicit terms discloses exactly what it did before.
    expect(personalCheckoutDisclosure(checkoutDisclosureTerms(LEGACY_12, defaultBillingTerm(LEGACY_12)!, false))).toBe(personalCheckoutDisclosure(LEGACY_12.plan));
    expect(businessCheckoutDisclosure(checkoutDisclosureTerms(LEGACY_12, defaultBillingTerm(LEGACY_12)!, false))).toBe(businessCheckoutDisclosure(LEGACY_12.plan));
    expect(businessCheckoutDisclosure(checkoutDisclosureTerms(TWO, billingTermOf(TWO, 'MONTHLY')!, true))).toBe(
      'Your plan is billed monthly and continues month to month until you cancel in your billing settings; a cancellation takes effect at the end of the current monthly period.',
    );
    expect(businessCheckoutDisclosure(checkoutDisclosureTerms(TWO, billingTermOf(TWO, 'ANNUAL_COMMIT')!, true))).toContain('12-month commitment, billed monthly. After that it continues at the monthly price ($12.00)');
  });
});

// ---- checkout and catalog through the lifecycle (fakes) ---------------------------------------

function harness(content: PlanVersionContent, pins: { term: string | null; ref: string }[], gateway: 'STRIPE' | 'RAZORPAY' = 'STRIPE') {
  const plan = { id: 'plan-1', key: content.plan.key, name: 'Standard', description: null, product_key: 'sign', sellable: true, status: 'ACTIVE', sales_model: 'SELF_SERVICE', tenant_kind: content.plan.tenant_kind, display_order: 1, activation_note: null };
  const version = versionOf(content);
  const intents: Record<string, unknown>[] = [];
  const lookups: Array<string | null> = [];
  const sessions: Record<string, unknown>[] = [];
  const tx = {
    $executeRaw: async () => 1,
    tenantSubscription: { findFirst: async () => null },
    checkoutIntent: { create: async (a: { data: Record<string, unknown> }) => (intents.push(a.data), a.data) },
  };
  const prisma = {
    plan: { findUnique: async () => plan, findMany: async () => [{ ...plan, versions: [version] }] },
    planVersion: { findFirst: async () => version },
    planVersionPrice: {
      findFirst: async ({ where }: { where: { provider: string; term: string | null } }) => {
        lookups.push(where.term);
        const pin = where.provider === gateway ? pins.find((p) => p.term === where.term) : undefined;
        return pin === undefined ? null : { provider_price_ref: pin.ref, term: pin.term };
      },
    },
    tenantSubscription: { findFirst: async () => null },
    tenantBillingAccount: { findUnique: async () => null, upsert: async () => ({}) },
    checkoutIntent: { update: async () => ({}) },
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const port = {
    provider: 'STRIPE',
    isConfigured: () => true,
    mode: () => 'test',
    upsertBillingAccount: async () => 'acct_1',
    createCheckoutSession: async (r: Record<string, unknown>) => (sessions.push(r), { session_ref: 'cs_1', url: 'https://checkout.test/s' }),
  } as unknown as BillingProviderPort;
  const svc = new SubscriptionLifecycleService(prisma as never, {} as never, port, {} as never, undefined, []);
  const start = (term?: 'MONTHLY' | 'ANNUAL_COMMIT') =>
    svc.startCheckout({ tenant_id: 't-1', product_key: 'sign', user_id: 'u-1', user_email: 'o@x.test', plan_key: plan.key, success_url: 'https://e/ok', cancel_url: 'https://e/no', tenant_kind: 'PERSONAL', ...(term !== undefined ? { term } : {}) });
  return { svc, start, intents, lookups, sessions };
}

const reason = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof BillingRefusedError ? e.reason : String(e)));

describe('§3.3 checkout — term in the request (default MONTHLY), recorded on the intent, priced on its own pin', () => {
  const PINS = [{ term: 'MONTHLY', ref: 'price_m' }, { term: 'ANNUAL_COMMIT', ref: 'price_a' }];

  it('a two-term version: no term → MONTHLY on its pin; ANNUAL_COMMIT → its own pin; each disclosed', async () => {
    const h = harness(TWO, PINS);
    await h.start();
    await h.start('ANNUAL_COMMIT');
    expect(h.lookups).toEqual(['MONTHLY', 'ANNUAL_COMMIT']);
    expect(h.intents.map((i) => i['term'])).toEqual(['MONTHLY', 'ANNUAL_COMMIT']);
    expect(h.sessions.map((s) => s['price_ref'])).toEqual(['price_m', 'price_a']);
    expect(String(h.sessions[0]?.['disclosure'])).not.toContain('commitment');
    expect(String(h.sessions[1]?.['disclosure'])).toContain('12-month commitment');
  });

  it('a version without explicit terms sells its one term on its legacy pin, exactly as before', async () => {
    const h = harness(LEGACY_12, [{ term: null, ref: 'price_legacy' }]);
    await h.start();
    await h.start('ANNUAL_COMMIT');
    expect(h.lookups).toEqual([null, null]);
    expect(h.sessions.map((s) => s['price_ref'])).toEqual(['price_legacy', 'price_legacy']);
    expect(h.intents.map((i) => i['term'])).toEqual(['ANNUAL_COMMIT', 'ANNUAL_COMMIT']);
    expect(h.sessions[0]?.['disclosure']).toBe(personalCheckoutDisclosure(LEGACY_12.plan));
    // It does not sell a MONTHLY term: refused before any intent or provider call.
    const before = h.intents.length;
    expect(await reason(h.start('MONTHLY'))).toBe('TERM_NOT_AVAILABLE');
    expect(h.intents.length).toBe(before);
  });

  it('a term without a provider price fails closed (BILLING_UNAVAILABLE), never another term', async () => {
    const h = harness(TWO, [{ term: 'MONTHLY', ref: 'price_m' }]);
    expect(await reason(h.start('ANNUAL_COMMIT'))).toBe('BILLING_UNAVAILABLE');
    expect(h.sessions).toEqual([]);
  });

  it('the catalog lists every term with its price, commitment and purchasability (default = MONTHLY)', async () => {
    const h = harness(TWO, [{ term: 'MONTHLY', ref: 'price_m' }]);
    const [plan] = await h.svc.catalog('sign', 't-1', 'PERSONAL');
    expect(plan?.price).toEqual({ amount_minor: 1200, currency: 'USD', interval: 'MONTH' });
    expect(plan?.commitment_months).toBeNull();
    expect(plan?.purchasable).toBe(true);
    expect(plan?.billing_terms).toEqual([
      { term: 'MONTHLY', price: { amount_minor: 1200, currency: 'USD', interval: 'MONTH' }, commitment_months: null, default: true, purchasable: true, web_only: false },
      { term: 'ANNUAL_COMMIT', price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' }, commitment_months: 12, default: false, purchasable: false, web_only: true },
    ]);
    const legacy = await harness(LEGACY_12, [{ term: null, ref: 'price_legacy' }]).svc.catalog('sign', 't-1', 'PERSONAL');
    expect(legacy[0]?.billing_terms).toEqual([
      { term: 'ANNUAL_COMMIT', price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' }, commitment_months: 12, default: true, purchasable: true, web_only: false },
    ]);
  });
});
