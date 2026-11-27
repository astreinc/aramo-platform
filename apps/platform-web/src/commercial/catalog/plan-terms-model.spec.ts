import { describe, expect, it } from 'vitest';

import { offersFreeAdoption, parseDailyCapInput, planTermsRows } from './plan-terms-model';
import type { CatalogVersionTerms } from './catalog-api';

// SIGN-FREE-PARITY-1 S1 / S5 — the console model of the version's other terms.

const FREE_V2 = {
  list_price_minor: 0,
  currency: 'USD',
  billing_interval: 'MONTH',
  sales_model: 'FREE',
  contract_priced: false,
  envelopes_per_month: 5,
  envelopes_unlimited: false,
  envelopes_present: true,
  storage_bytes: 15728640,
  storage_unlimited: false,
  storage_present: true,
  envelopes_per_day: 2,
  allowance_keys: ['sign.envelopes', 'sign.forms'],
  description: 'For individuals: 5 E-Signs a month (up to 2 a day) and 15 MB storage.',
  features: [{ feature_key: 'sign.whatsapp_delivery', enabled: false }],
} satisfies CatalogVersionTerms;

describe('plan terms model', () => {
  it('FP-W-1 shows the daily cap, the removable allowances and the feature entitlements', () => {
    const r = planTermsRows(FREE_V2);
    expect(r.dailyCapPresent).toBe(true);
    expect(r.dailyCapText).toBe('2');
    expect(r.allowances).toEqual([
      { key: 'sign.envelopes', label: 'Envelopes', removable: false },
      { key: 'sign.forms', label: 'Forms (not built)', removable: true },
    ]);
    expect(r.features).toEqual([{ key: 'sign.whatsapp_delivery', label: 'WhatsApp delivery', enabled: false }]);
  });

  it('FP-W-2 an older platform-admin without the fields shows nothing to edit', () => {
    const { envelopes_per_day: _d, allowance_keys: _a, description: _s, features: _f, ...old } = FREE_V2;
    expect(planTermsRows(old)).toEqual({ dailyCapPresent: false, dailyCapText: '', allowances: [], features: [] });
  });

  it('FP-W-3 parses the daily cap input: empty removes it; 1 or more edits it', () => {
    expect(parseDailyCapInput('')).toEqual({ ok: true, value: null });
    expect(parseDailyCapInput(' 3 ')).toEqual({ ok: true, value: 3 });
    expect(parseDailyCapInput('0')).toEqual({ ok: false });
    expect(parseDailyCapInput('2.5')).toEqual({ ok: false });
  });

  it('FP-W-4 offers the Free-subscriber move only on a FREE plan', () => {
    expect(offersFreeAdoption(FREE_V2)).toBe(true);
    expect(offersFreeAdoption({ ...FREE_V2, sales_model: 'SELF_SERVICE' })).toBe(false);
  });
});
