import { describe, expect, it } from 'vitest';

import { CatalogDraftEditError, applyCatalogDraftEdits, catalogTermsOf, isContractPriced } from '../lib/commercial/commercial-catalog.js';
import { type PlanVersionContent, PlanVersionContentError, parsePlanVersionContent, planVersionChecksum, planVersionTerms, unitPriceOf, withUnitPrices } from '../lib/plan-version.js';

// CCP-B2 — the pure catalog model: the editor terms read from a format-1 content document, and
// the only draft edits the console can make (price, envelopes per month, storage), fail closed.

const BUSINESS: PlanVersionContent = {
  format: 1,
  plan: {
    key: 'aramo-sign-standard-business-v1',
    product_key: 'sign',
    name: 'Standard Business',
    description: 'd',
    tenant_kind: 'BUSINESS',
    sales_model: 'SELF_SERVICE',
    list_price_minor: 2000,
    currency: 'USD',
    reference_price_minor: 3000,
    reference_price_substantiated: false,
    billing_interval: 'MONTH',
    commitment_months: 12,
    eligibility: null,
    support_tier: 'BASIC',
  },
  allowances: [
    { allowance_key: 'sign.envelopes', included_quantity: null, unlimited: true, period: 'MONTHLY' },
    { allowance_key: 'sign.forms', included_quantity: null, unlimited: true, period: 'MONTHLY' },
  ],
  allowance_windows: [],
  capacities: [
    { capacity_key: 'sign.templates', limit_quantity: null, unlimited: true },
    { capacity_key: 'sign.storage_bytes', limit_quantity: 10737418240, unlimited: false },
  ],
  features: [{ feature_key: 'sign.team_collaboration', enabled: true }],
};
const ENTERPRISE: PlanVersionContent = {
  ...BUSINESS,
  plan: { ...BUSINESS.plan, key: 'aramo-sign-enterprise-v1', name: 'Enterprise', sales_model: 'CONTACT_SALES', list_price_minor: null, currency: null, billing_interval: null, commitment_months: null, support_tier: 'CONTRACTED', reference_price_minor: null },
  allowances: [],
  capacities: [],
  features: [],
};

describe('CCP-B2 catalog model', () => {
  it('B2-U-1 reads the editor terms (price, unlimited envelopes, storage, v1 locks)', () => {
    expect(catalogTermsOf(BUSINESS)).toEqual({
      list_price_minor: 2000,
      currency: 'USD',
      billing_interval: 'MONTH',
      sales_model: 'SELF_SERVICE',
      contract_priced: false,
      envelopes_per_month: null,
      envelopes_unlimited: true,
      envelopes_present: true,
      storage_bytes: 10737418240,
      storage_unlimited: false,
      storage_present: true,
      unit_prices: [],
    });
    expect(catalogTermsOf(ENTERPRISE)).toMatchObject({ contract_priced: true, envelopes_present: false, storage_present: false, list_price_minor: null });
    expect(isContractPriced(ENTERPRISE)).toBe(true);
  });

  it('B2-U-2 edits only the named terms; every other byte of the content is kept', () => {
    const next = applyCatalogDraftEdits(BUSINESS, { list_price_minor: 2400, envelopes_per_month: 750, storage_bytes: 53687091200 });
    expect(next.plan).toEqual({ ...BUSINESS.plan, list_price_minor: 2400 });
    expect(next.allowances).toEqual([{ allowance_key: 'sign.envelopes', included_quantity: 750, unlimited: false, period: 'MONTHLY' }, BUSINESS.allowances[1]]);
    expect(next.capacities).toEqual([BUSINESS.capacities[0], { capacity_key: 'sign.storage_bytes', limit_quantity: 53687091200, unlimited: false }]);
    expect(next.features).toEqual(BUSINESS.features);
    expect(planVersionChecksum(applyCatalogDraftEdits(BUSINESS, {}))).toBe(planVersionChecksum(BUSINESS));
    expect(applyCatalogDraftEdits(next, { envelopes_per_month: null }).allowances[0]).toEqual({ allowance_key: 'sign.envelopes', included_quantity: null, unlimited: true, period: 'MONTHLY' });
  });

  it('B2-U-3 fails closed: a contract-priced price, a term the version lacks, a negative or fractional value', () => {
    const reason = (f: () => unknown): string | null => {
      try {
        f();
        return null;
      } catch (e) {
        return e instanceof CatalogDraftEditError ? e.reason : 'other';
      }
    };
    expect(reason(() => applyCatalogDraftEdits(ENTERPRISE, { list_price_minor: 1 }))).toBe('contract_priced');
    expect(reason(() => applyCatalogDraftEdits(ENTERPRISE, { envelopes_per_month: 1 }))).toBe('term_missing');
    expect(reason(() => applyCatalogDraftEdits(ENTERPRISE, { storage_bytes: 1 }))).toBe('term_missing');
    expect(reason(() => applyCatalogDraftEdits(BUSINESS, { list_price_minor: -1 }))).toBe('term_missing');
    expect(reason(() => applyCatalogDraftEdits(BUSINESS, { envelopes_per_month: 1.5 }))).toBe('term_missing');
  });

  it('B2-U-4 never adds a term key, never changes the plan identity or the v1 locks', () => {
    const next = applyCatalogDraftEdits(BUSINESS, { list_price_minor: 1, envelopes_per_month: 1, storage_bytes: 1 });
    expect(next.allowances.map((a) => a.allowance_key)).toEqual(BUSINESS.allowances.map((a) => a.allowance_key));
    expect(next.capacities.map((c) => c.capacity_key)).toEqual(BUSINESS.capacities.map((c) => c.capacity_key));
    expect([next.plan.key, next.plan.product_key, next.plan.name, next.plan.currency, next.plan.billing_interval]).toEqual(['aramo-sign-standard-business-v1', 'sign', 'Standard Business', 'USD', 'MONTH']);
  });
});

// Sign Feature Parity Amendment A3 (D1) and A4 (D2) — the add-on unit prices are part of the
// version's canonical content (so content_checksum, the approval fingerprint, covers them), and the
// catalog role edits them on a DRAFT through the same draft-edit path.
describe('A3 D1 / A4 D2 add-on unit prices in the plan-version content', () => {
  it('D1-U-1 an existing (unpriced) version keeps its exact fingerprint; adding a price changes it', () => {
    const before = planVersionChecksum(BUSINESS);
    expect(planVersionChecksum(parsePlanVersionContent(BUSINESS))).toBe(before);
    expect(parsePlanVersionContent(BUSINESS)).not.toHaveProperty('unit_prices');
    const priced = withUnitPrices(BUSINESS, new Map([['sign.sms_message', 5]]));
    expect(priced.unit_prices).toEqual([{ unit_key: 'sign.sms_message', unit_price_minor: 5, currency: 'USD' }]);
    expect(planVersionChecksum(priced)).not.toBe(before);
    const repriced = withUnitPrices(priced, new Map([['sign.sms_message', 6]]));
    expect(planVersionChecksum(repriced)).not.toBe(planVersionChecksum(priced));
    // Removing every price restores the unpriced bytes and fingerprint.
    expect(planVersionChecksum(withUnitPrices(priced, new Map()))).toBe(before);
  });

  it('D1-U-2 the parser is strict: sorted, unique, registry units of the plan product, integer cents, USD, never an empty array', () => {
    const bad = (unit_prices: unknown) => () => parsePlanVersionContent({ ...BUSINESS, unit_prices });
    expect(bad([])).toThrow(PlanVersionContentError);
    expect(bad([{ unit_key: 'sign.envelopes', unit_price_minor: 1, currency: 'USD' }])).toThrow(/must be one of/);
    expect(bad([{ unit_key: 'sign.sms_message', unit_price_minor: 1.5, currency: 'USD' }])).toThrow(PlanVersionContentError);
    expect(bad([{ unit_key: 'sign.sms_message', unit_price_minor: -1, currency: 'USD' }])).toThrow(PlanVersionContentError);
    expect(bad([{ unit_key: 'sign.sms_message', unit_price_minor: 10_000_001, currency: 'USD' }])).toThrow(PlanVersionContentError);
    expect(bad([{ unit_key: 'sign.sms_message', unit_price_minor: 1, currency: 'EUR' }])).toThrow(/USD/);
    expect(bad([{ unit_key: 'sign.sms_message', unit_price_minor: 1, currency: 'USD', extra: 1 }])).toThrow(PlanVersionContentError);
    expect(
      bad([
        { unit_key: 'sign.whatsapp_message', unit_price_minor: 1, currency: 'USD' },
        { unit_key: 'sign.sms_message', unit_price_minor: 1, currency: 'USD' },
      ]),
    ).toThrow(/sorted/);
    expect(
      bad([
        { unit_key: 'sign.sms_message', unit_price_minor: 1, currency: 'USD' },
        { unit_key: 'sign.sms_message', unit_price_minor: 2, currency: 'USD' },
      ]),
    ).toThrow(/sorted/);
    const ok = parsePlanVersionContent({ ...BUSINESS, unit_prices: [{ unit_key: 'sign.id_verification', unit_price_minor: 150, currency: 'USD' }] });
    expect(unitPriceOf(ok, 'sign.id_verification')).toEqual({ unit_key: 'sign.id_verification', unit_price_minor: 150, currency: 'USD' });
    expect(unitPriceOf(ok, 'sign.kba')).toBeNull();
    // A tampered price fails the checksum verification (no price is read from an unverified version).
    const row = { id: 'v', content: ok, content_checksum: planVersionChecksum(ok) };
    expect(planVersionTerms(row).unit_prices).toHaveLength(1);
    expect(() => planVersionTerms({ ...row, content: { ...ok, unit_prices: [{ unit_key: 'sign.id_verification', unit_price_minor: 1, currency: 'USD' }] } })).toThrow(/checksum mismatch/);
  });

  it('D2-U-1 the catalog edits add, change and remove unit prices on a draft; the fingerprint follows; other units are kept', () => {
    const a = applyCatalogDraftEdits(BUSINESS, { unit_prices: { 'sign.sms_message': 5, 'sign.id_verification': 150 } });
    expect(catalogTermsOf(a).unit_prices).toEqual([
      { unit_key: 'sign.id_verification', unit_price_minor: 150 },
      { unit_key: 'sign.sms_message', unit_price_minor: 5 },
    ]);
    const b = applyCatalogDraftEdits(a, { unit_prices: { 'sign.sms_message': 7 } });
    expect(unitPriceOf(b, 'sign.sms_message')?.unit_price_minor).toBe(7);
    expect(unitPriceOf(b, 'sign.id_verification')?.unit_price_minor).toBe(150);
    expect(planVersionChecksum(b)).not.toBe(planVersionChecksum(a));
    const c = applyCatalogDraftEdits(b, { unit_prices: { 'sign.sms_message': null, 'sign.id_verification': null } });
    expect(c).not.toHaveProperty('unit_prices');
    expect(planVersionChecksum(c)).toBe(planVersionChecksum(BUSINESS));
    // A price edit keeps every other term, and a term edit keeps the prices.
    expect(applyCatalogDraftEdits(a, { list_price_minor: 2500 }).unit_prices).toEqual(a.unit_prices);
    expect(b.plan).toEqual(BUSINESS.plan);
  });

  it('D2-U-2 unit-price edits fail closed: an unknown unit, another product, a bad price', () => {
    const edit = (unit_prices: Record<string, number | null>) => () => applyCatalogDraftEdits(BUSINESS, { unit_prices });
    expect(edit({ 'sign.envelopes': 1 })).toThrow(CatalogDraftEditError);
    expect(edit({ 'ats.sms_message': 1 })).toThrow(CatalogDraftEditError);
    expect(edit({ 'sign.sms_message': -1 })).toThrow(CatalogDraftEditError);
    expect(edit({ 'sign.sms_message': 0.5 })).toThrow(CatalogDraftEditError);
    expect(edit({ 'sign.sms_message': 10_000_001 })).toThrow(CatalogDraftEditError);
    // Removing a price that is not there is a no-op, not an error.
    expect(applyCatalogDraftEdits(BUSINESS, { unit_prices: { 'sign.kba': null } })).toEqual(BUSINESS);
  });
});
