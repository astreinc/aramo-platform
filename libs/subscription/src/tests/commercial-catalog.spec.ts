import { describe, expect, it } from 'vitest';

import { CatalogDraftEditError, applyCatalogDraftEdits, catalogTermsOf, isContractPriced } from '../lib/commercial/commercial-catalog.js';
import { type PlanVersionContent, planVersionChecksum } from '../lib/plan-version.js';

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
