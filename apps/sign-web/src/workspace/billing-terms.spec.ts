import { ApiError } from '@aramo/fe-foundation';
import { describe, expect, it } from 'vitest';

import { errorMessage } from './api';
import { initialTerm, planTerms, termCommitmentText, termDisclosureText, termSavingText } from './catalog';

// Sign Monthly and Annual-Commitment Pricing v1.0 — the pure term helpers of the plan pages.
describe('billing terms', () => {
  const M = { term: 'MONTHLY' as const, amount_minor: 2000, currency: 'USD', commitment_months: null, purchasable: true, default: true };
  const A = { term: 'ANNUAL_COMMIT' as const, amount_minor: 1600, currency: 'USD', commitment_months: 12, purchasable: true, default: false };

  it('an older backend (no billing_terms) reads as one term from the plan fields', () => {
    expect(planTerms({ price: { amount_minor: 1000, currency: 'USD' }, commitment_months: 12, purchasable: false })).toEqual([
      { term: 'ANNUAL_COMMIT', amount_minor: 1000, currency: 'USD', commitment_months: 12, purchasable: false, default: true },
    ]);
    expect(planTerms({ price: null, commitment_months: null })).toEqual([]);
  });

  it('Monthly is chosen first; commitment, saving and disclosure copy', () => {
    expect(initialTerm([A, M])).toBe('MONTHLY');
    expect(initialTerm([A])).toBe('ANNUAL_COMMIT');
    expect(initialTerm([])).toBeNull();
    expect(termCommitmentText(M)).toBe('No commitment, cancel anytime');
    expect(termCommitmentText(A)).toBe('12-month commitment, billed monthly');
    expect(termSavingText(A, M)).toBe('Save $4/month (20%)');
    expect(termSavingText(M, M)).toBeNull();
    expect(termDisclosureText(M, M)).toBe('$20/month, billed monthly with no commitment. Cancel anytime; your plan ends at the end of the month you’ve paid for.');
    expect(termDisclosureText(A, M)).toBe(
      '$16/month, 12-month commitment billed monthly. After the commitment it continues month to month at the Monthly price ($20/month) until you cancel; a cancellation inside the commitment takes effect at its end.',
    );
  });

  it('422 term_not_available has its own message', () => {
    expect(errorMessage(new ApiError(422, 'raw', 'VALIDATION_ERROR', { reason: 'term_not_available' }))).toBe(
      'That billing option isn’t available for this plan. Choose another option and try again.',
    );
  });
});
