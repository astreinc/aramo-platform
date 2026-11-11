import { describe, expect, it } from 'vitest';

import { billingApprovalRows } from './PlanVersionApprovalTerms';

// CCP Billing Products (BP-5 / BP-11) — what Finance and the Owner see about channels on a publish request.

describe('billing approval rows', () => {
  it('lists each channel with its exact preview prices, every stop, and the screenshot', () => {
    const rows = billingApprovalRows(
      {
        plan_version_id: 'v',
        billing_products: {
          products: [
            { provider: 'STRIPE', interval: 'MONTH', product_id: 'aramo_sign_personal_standard' },
            { provider: 'APP_STORE', interval: 'MONTH', product_id: 'ai.aramo.sign.personal_standard.monthly' },
          ],
          stop_selling: ['GOOGLE_PLAY'],
          apple_review_screenshot_asset_id: '019a0000-0000-7000-8000-0000000000aa',
        },
      },
      [
        { provider: 'STRIPE', interval: 'MONTH', product_id: 'aramo_sign_personal_standard', configured: true, error: null, prices: [{ country: 'US', currency: 'USD', amount_minor: 1000, available: true, nearest: [] }] },
        { provider: 'APP_STORE', interval: 'MONTH', product_id: 'ai.aramo.sign.personal_standard.monthly', configured: false, error: null, prices: [] },
      ],
    );
    expect(rows).toEqual([
      { field: 'Sells on Web (Stripe)', value: 'aramo_sign_personal_standard · US 10.00 USD' },
      { field: 'Sells on iPhone (App Store)', value: 'ai.aramo.sign.personal_standard.monthly · price checked when it syncs' },
      { field: 'Stops selling on Android (Google Play)', value: 'Yes: new purchases on this channel end with this version' },
      { field: 'App Store review screenshot', value: 'Attached' },
    ]);
  });
  it('says so when a request carries no billing products', () => {
    expect(billingApprovalRows({ plan_version_id: 'v' }, null)).toEqual([{ field: 'Billing products', value: 'None in this request (the plan sells on no channel)' }]);
  });
});
