import { describe, expect, it } from 'vitest';

import { withheldCount, withheldLine } from './finance-model';

// Amendment M-A12-A2 R-4 — an app-store test purchase (Apple sandbox, Google Play test purchase) is
// never revenue, so the Withheld tile does not count it as withheld, as it does not count a row
// excluded only for its status.
describe('Withheld tile and app-store test purchases (M-A12-A2)', () => {
  const byReason = { STORE_TEST_PURCHASE: 2, STATUS_NOT_REVENUE_BEARING: 3, CONTRACT_PRICED: 1, NON_USD_CURRENCY: 1 };

  it('withheldCount leaves out test purchases and status-only exclusions', () => {
    expect(withheldCount(byReason)).toBe(2);
  });

  it('withheldLine names only real withheld reasons', () => {
    expect(withheldLine(byReason)).toBe('1 contract-priced, 1 non-USD');
    expect(withheldLine({ STORE_TEST_PURCHASE: 4, STATUS_NOT_REVENUE_BEARING: 1 })).toBe('None');
  });
});
