import { describe, expect, it } from 'vitest';

import type { BillingProductView } from './catalog-api';
import { billingEditorErrors, billingPayload, billingStatusText, canRetry, defaultProductId, formatMinor, initialBillingRows, needsReviewScreenshot } from './billing-products-model';

// CCP Billing Products Directive v1.0 (LOCKED) — the console's billing-products model.

const KEY = 'aramo-sign-standard-personal-v1';
const ALL = ['STRIPE', 'APP_STORE', 'GOOGLE_PLAY'] as const;
const view = (over: Partial<BillingProductView>): BillingProductView => ({ provider: 'APP_STORE', interval: 'MONTH', product_id: 'ai.aramo.sign.personal_standard.monthly', origin: 'ADOPTED', linked: false, sync: null, ...over });

describe('billing products model', () => {
  it('starts a first publish with every eligible channel selected at the default ids', () => {
    const rows = initialBillingRows({ billing_eligible: [...ALL], billing_carry_forward: [], billing_products: [] }, KEY);
    expect(rows.map((r) => [r.provider, r.product_id, r.selected, r.locked])).toEqual([
      ['STRIPE', 'aramo_sign_personal_standard', true, false],
      ['APP_STORE', 'ai.aramo.sign.personal_standard.monthly', true, false],
      ['GOOGLE_PLAY', 'ai.aramo.sign.personal_standard.monthly', true, false],
    ]);
    expect(needsReviewScreenshot(rows)).toBe(true);
    expect(billingEditorErrors(rows, null)).toEqual(['A new App Store product needs the review screenshot of the in-app Plans screen.']);
  });

  it('locks a permanent id and needs no screenshot for an existing App Store product', () => {
    const rows = initialBillingRows({ billing_eligible: ['APP_STORE'], billing_carry_forward: [], billing_products: [view({})] }, KEY);
    expect(rows[0]).toMatchObject({ locked: true, product_id: 'ai.aramo.sign.personal_standard.monthly' });
    expect(billingEditorErrors(rows, null)).toEqual([]);
  });

  it('turns an unticked channel the plan sells on into an explicit stop, and sends the screenshot only when needed', () => {
    const rows = initialBillingRows(
      { billing_eligible: [...ALL], billing_carry_forward: [{ provider: 'STRIPE', interval: 'MONTH', product_id: 'aramo_sign_personal_standard' }, { provider: 'GOOGLE_PLAY', interval: 'MONTH', product_id: 'ai.aramo.sign.personal_standard.monthly' }], billing_products: [view({ provider: 'STRIPE', product_id: 'aramo_sign_personal_standard' })] },
      KEY,
    ).map((r) => (r.provider === 'GOOGLE_PLAY' ? { ...r, selected: false } : r));
    expect(billingPayload(rows, 'shot-1')).toEqual({
      products: [
        { provider: 'STRIPE', interval: 'MONTH', product_id: 'aramo_sign_personal_standard' },
        { provider: 'APP_STORE', interval: 'MONTH', product_id: 'ai.aramo.sign.personal_standard.monthly' },
      ],
      stop_selling: ['GOOGLE_PLAY'],
      apple_review_screenshot_asset_id: 'shot-1',
    });
  });

  it('a Business plan offers the web only', () => {
    const rows = initialBillingRows({ billing_eligible: ['STRIPE'], billing_carry_forward: [], billing_products: [] }, 'aramo-sign-standard-business-v1');
    expect(rows.map((r) => r.product_id)).toEqual(['aramo_sign_business_standard']);
    expect(defaultProductId('APP_STORE', 'aramo-sign-standard-professional-v1')).toBe('ai.aramo.sign.professional_standard.monthly');
  });

  it('refuses ids the provider does not accept', () => {
    const rows = [{ provider: 'STRIPE' as const, interval: 'MONTH' as const, selected: true, product_id: 'a.b', locked: false, sold: false }];
    expect(billingEditorErrors(rows, null)[0]).toMatch(/characters the store does not accept/);
  });

  it('describes sync status and offers a retry only after a failure', () => {
    const sync = { id: 's', change_request_id: 'c', plan_version_id: 'v', attempts: 1, store_state: 'READY_TO_SUBMIT', last_error: null, synced_at: '2026-11-11T00:00:00Z', next_attempt_at: '2026-11-11T00:00:00Z' };
    expect(billingStatusText(view({ sync: { ...sync, status: 'SYNCED' } }))).toMatchObject({ label: 'In sync · store state READY_TO_SUBMIT', tone: 'ok' });
    expect(canRetry(view({ sync: { ...sync, status: 'SYNCED' } }))).toBe(false);
    expect(canRetry(view({ sync: { ...sync, status: 'NEEDS_ATTENTION', last_error: 'no price point' } }))).toBe(true);
    expect(billingStatusText(view({ linked: true }))).toMatchObject({ label: 'Selling' });
    expect(formatMinor(1000, 'USD')).toBe('10.00 USD');
    expect(formatMinor(1500, 'JPY')).toBe('1500 JPY');
  });
});
