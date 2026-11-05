import { describe, expect, it } from 'vitest';

import { SubscriptionLifecycleService } from '../lib/billing/subscription-lifecycle.service.js';
import { applyCatalogDraftEdits, CatalogDraftEditError, catalogTermsOf } from '../lib/commercial/commercial-catalog.js';
import { CommercialPayloadError, validatePayload } from '../lib/commercial/commercial-change-request.js';
import { type PlanVersionContent, PlanVersionContentError, parsePlanVersionContent, planVersionChecksum, planVersionContentFromRows, regionalPricesOf, withRegionalPrices } from '../lib/plan-version.js';

// Aramo Sign Mobile M-A12 §4 item 3 (R-2, A5) — the plans list is filtered to the caller's tenant kind
// (Personal sees 0 BUSINESS plans; Business sees 0 PERSONAL plans). Amendment A1-3 — regional list
// prices are version TERMS: strict content (never US, sorted, unique), covered by the checksum, edited
// on a DRAFT through the governed catalog path (the fingerprint Finance and the Owner approve), and the
// PLAN_VERSION_PUBLISH payload carries the store product pins (closed shape).

const contentOf = (key: string, kind: string | null, sales_model = 'SELF_SERVICE', list: number | null = 1500): PlanVersionContent =>
  planVersionContentFromRows({
    plan: { key, product_key: 'sign', name: key, description: null, tenant_kind: kind, sales_model, list_price_minor: list, currency: list === null ? null : 'USD', reference_price_minor: null, reference_price_substantiated: false, billing_interval: 'MONTH', commitment_months: 12, eligibility: null, support_tier: null },
    allowances: [],
    allowance_windows: [],
    capacities: [],
    features: [],
  });

function lifecycleWith(plans: { key: string; tenant_kind: string | null }[]): SubscriptionLifecycleService {
  const rows = plans.map((p, i) => {
    const content = contentOf(p.key, p.tenant_kind);
    return {
      id: `plan-${String(i)}`,
      key: p.key,
      name: p.key,
      description: null,
      tenant_kind: p.tenant_kind,
      sales_model: 'SELF_SERVICE',
      status: 'ACTIVE',
      sellable: true,
      activation_note: null,
      versions: [{ id: `v-${String(i)}`, content, content_checksum: planVersionChecksum(content) }],
    };
  });
  const prisma = { plan: { findMany: async () => rows }, planVersionPrice: { findUnique: async () => null } };
  const billing = { provider: 'STRIPE', isConfigured: () => true };
  return new SubscriptionLifecycleService(prisma as never, {} as never, billing as never, {} as never);
}

describe('M-A12 R-2 — the plans list is filtered to the caller’s tenant kind (A5: Personal stays Personal)', () => {
  const svc = lifecycleWith([
    { key: 'aramo-sign-free-personal-v1', tenant_kind: 'PERSONAL' },
    { key: 'aramo-sign-standard-personal-v1', tenant_kind: 'PERSONAL' },
    { key: 'aramo-sign-business-v2', tenant_kind: 'BUSINESS' },
    { key: 'aramo-sign-professional-v2', tenant_kind: 'BUSINESS' },
    { key: 'aramo-sign-any-kind', tenant_kind: null },
  ]);

  it('a PERSONAL tenant sees 0 BUSINESS plans', async () => {
    const plans = await svc.catalog('sign', 't', 'PERSONAL');
    expect(plans.filter((p) => p.tenant_kind === 'BUSINESS')).toHaveLength(0);
    expect(plans.map((p) => p.key)).toEqual(['aramo-sign-free-personal-v1', 'aramo-sign-standard-personal-v1', 'aramo-sign-any-kind']);
  });

  it('a BUSINESS tenant sees 0 PERSONAL plans', async () => {
    const plans = await svc.catalog('sign', 't', 'BUSINESS');
    expect(plans.filter((p) => p.tenant_kind === 'PERSONAL')).toHaveLength(0);
    expect(plans.map((p) => p.key)).toEqual(['aramo-sign-business-v2', 'aramo-sign-professional-v2', 'aramo-sign-any-kind']);
  });

  it('without a tenant kind (operator / unscoped reads) every plan is listed, as before', async () => {
    expect(await svc.catalog('sign')).toHaveLength(5);
  });
});

describe('M-A12 A1-3 — regional list prices in the plan version content', () => {
  const base = contentOf('aramo-sign-business-v2', 'BUSINESS');
  const IN_M = { country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' as const };
  const IN_Y = { country: 'IN', currency: 'INR', amount_minor: 899900, interval: 'YEAR' as const };
  const BR_M = { country: 'BR', currency: 'BRL', amount_minor: 4990, interval: 'MONTH' as const };

  it('absent = byte-identical to the pre-A1-3 document (every existing version keeps its checksum)', () => {
    expect(planVersionChecksum(withRegionalPrices(base, []))).toBe(planVersionChecksum(base));
    expect('regional_prices' in withRegionalPrices(base, [])).toBe(false);
  });

  it('canonical: sorted by country then interval, covered by the checksum', () => {
    const c = withRegionalPrices(base, [IN_Y, BR_M, IN_M]);
    expect(c.regional_prices).toEqual([BR_M, IN_M, IN_Y]);
    expect(planVersionChecksum(c)).not.toBe(planVersionChecksum(base));
    expect(parsePlanVersionContent(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(regionalPricesOf(c, 'in')).toEqual([IN_M, IN_Y]);
    expect(regionalPricesOf(c, null)).toEqual([]);
  });

  it('strict: never US, never empty, sorted and unique, ISO codes, MONTH | YEAR, bounded amounts', () => {
    const bad = (regional_prices: unknown) => () => parsePlanVersionContent({ ...base, regional_prices });
    expect(bad([])).toThrow(PlanVersionContentError);
    expect(bad([{ ...IN_M, country: 'US', currency: 'USD' }])).toThrow(/US is the plan's list price/);
    expect(bad([IN_M, BR_M])).toThrow(/sorted/);
    expect(bad([IN_M, IN_M])).toThrow(/sorted/);
    expect(bad([{ ...IN_M, country: 'in' }])).toThrow(/alpha-2/);
    expect(bad([{ ...IN_M, currency: 'RS' }])).toThrow(/ISO 4217/);
    expect(bad([{ ...IN_M, interval: 'WEEK' }])).toThrow(/MONTH or YEAR/);
    expect(bad([{ ...IN_M, amount_minor: -1 }])).toThrow(/amount_minor/);
    expect(bad([{ ...IN_M, extra: 1 }])).toThrow(/keys/);
  });

  it('draft edits (the console path): set, replace and remove by (country, interval); refused US and contract-priced plans', () => {
    const one = applyCatalogDraftEdits(base, { regional_prices: [{ country: 'in', interval: 'MONTH', currency: 'inr', amount_minor: 89900 }] });
    expect(catalogTermsOf(one).regional_prices).toEqual([IN_M]);
    const two = applyCatalogDraftEdits(one, { regional_prices: [{ ...IN_Y, amount_minor: 899900 }, { ...IN_M, amount_minor: 79900 }] });
    expect(catalogTermsOf(two).regional_prices).toEqual([{ ...IN_M, amount_minor: 79900 }, IN_Y]);
    const removed = applyCatalogDraftEdits(two, { regional_prices: [{ ...IN_M, amount_minor: null }, { ...IN_Y, amount_minor: null }] });
    expect(planVersionChecksum(removed)).toBe(planVersionChecksum(base));
    const reason = (f: () => unknown) => {
      try {
        f();
        return 'ACCEPTED';
      } catch (e) {
        return e instanceof CatalogDraftEditError ? e.reason : String(e);
      }
    };
    expect(reason(() => applyCatalogDraftEdits(base, { regional_prices: [{ country: 'US', interval: 'MONTH', currency: 'USD', amount_minor: 1 }] }))).toBe('term_missing');
    expect(reason(() => applyCatalogDraftEdits(contentOf('ent', 'BUSINESS', 'CONTACT_SALES', null), { regional_prices: [IN_M] }))).toBe('contract_priced');
    expect(reason(() => applyCatalogDraftEdits(base, { regional_prices: [{ ...IN_M, amount_minor: 1.5 }] }))).toBe('term_missing');
  });
});

describe('M-A12 W1-G — the PLAN_VERSION_PUBLISH payload pins store products (closed shape)', () => {
  const V = '019a1200-0000-7000-8000-0000000000d1';
  const errors = (p: unknown) => {
    try {
      validatePayload('PLAN_VERSION_PUBLISH', p);
      return [];
    } catch (e) {
      return e instanceof CommercialPayloadError ? [...e.errors] : [String(e)];
    }
  };
  it('accepts App Store and Google Play products with their interval', () => {
    expect(
      errors({
        plan_version_id: V,
        store_products: [
          { provider: 'APP_STORE', product_id: 'ai.aramo.sign.business.monthly', interval: 'MONTH' },
          { provider: 'APP_STORE', product_id: 'ai.aramo.sign.business.annual', interval: 'YEAR' },
          { provider: 'GOOGLE_PLAY', product_id: 'ai.aramo.sign.business.monthly', interval: 'MONTH' },
        ],
      }),
    ).toEqual([]);
  });
  it('refuses STRIPE, an unknown interval, extra keys, an empty list and a repeated provider + interval', () => {
    expect(errors({ plan_version_id: V, store_products: [{ provider: 'STRIPE', product_id: 'p', interval: 'MONTH' }] })).toEqual(['store_products[0].provider must be APP_STORE or GOOGLE_PLAY']);
    expect(errors({ plan_version_id: V, store_products: [{ provider: 'APP_STORE', product_id: 'p', interval: 'WEEK' }] })).toEqual(['store_products[0].interval must be MONTH or YEAR']);
    expect(errors({ plan_version_id: V, store_products: [{ provider: 'APP_STORE', product_id: 'p', interval: 'MONTH', price: 1 }] })).toEqual(['store_products[0].price is not allowed']);
    expect(errors({ plan_version_id: V, store_products: [] })).toEqual(['store_products must be an array of 1..4 store product pins']);
    expect(errors({ plan_version_id: V, store_products: [{ provider: 'APP_STORE', product_id: 'a', interval: 'MONTH' }, { provider: 'APP_STORE', product_id: 'b', interval: 'MONTH' }] })).toEqual(['store_products[1] repeats a provider and interval']);
  });
});
