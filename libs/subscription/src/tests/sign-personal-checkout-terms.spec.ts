import { describe, expect, it } from 'vitest';

import { checkoutTermsDocument, personalCheckoutDisclosure, planMatchesTenantKind } from '../lib/billing/subscription-lifecycle.service.js';

// Sign Catalog v2 §4.3 (P-4) — the pure checkout rules: Personal-only eligibility in both
// directions (fail closed on an unmarked plan for a PERSONAL tenant), the terms document per
// tenant kind, and the renewal disclosure built from the plan version's terms.

describe('Sign Catalog v2 — Personal checkout rules', () => {
  it('a PERSONAL tenant buys only a PERSONAL plan; a BUSINESS tenant never buys one', () => {
    expect(planMatchesTenantKind('PERSONAL', 'PERSONAL')).toBe(true);
    expect(planMatchesTenantKind('BUSINESS', 'PERSONAL')).toBe(false);
    expect(planMatchesTenantKind(null, 'PERSONAL')).toBe(false);
    expect(planMatchesTenantKind('BUSINESS', 'BUSINESS')).toBe(true);
    expect(planMatchesTenantKind(null, 'BUSINESS')).toBe(true);
    expect(planMatchesTenantKind('PERSONAL', 'BUSINESS')).toBe(false);
  });

  it('the checkout terms: the Personal Terms for a PERSONAL tenant, the Sign Terms otherwise', () => {
    expect(checkoutTermsDocument('PERSONAL')).toBe('sign.personal_terms_of_service');
    expect(checkoutTermsDocument('BUSINESS')).toBe('sign.terms_of_service');
  });

  it('the disclosure states the price, the commitment, renewal, cancellation and the return to Free', () => {
    const d = personalCheckoutDisclosure({ list_price_minor: 1000, currency: 'USD', billing_interval: 'MONTH', commitment_months: 12 })!;
    expect(d).toContain('$10.00 per month');
    expect(d).toContain('12-month commitment');
    expect(d).toContain('renews automatically each month');
    expect(d).toContain('cancel online from the last month of the commitment');
    expect(d).toContain('returns to the Free plan');
    expect(d.length).toBeLessThanOrEqual(1200);
    const noCommitment = personalCheckoutDisclosure({ list_price_minor: 1000, currency: 'USD', billing_interval: 'MONTH', commitment_months: null })!;
    expect(noCommitment).not.toContain('commitment');
    expect(personalCheckoutDisclosure({ list_price_minor: null, currency: null, billing_interval: null, commitment_months: 12 })).toBeNull();
  });
});
