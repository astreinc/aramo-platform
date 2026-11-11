import { describe, expect, it } from 'vitest';

import {
  billingProductsRuleErrors,
  billingProductsShapeErrors,
  defaultProductId,
  eligibleProviders,
  planSlug,
  type BillingProductsPayload,
} from '../lib/billing/sync/billing-product.js';

// CCP Billing Products Directive v1.0 (LOCKED) — the pure model: payload shape, BP-2 eligibility,
// BP-3 permanent ids and default ids, BP-11 carry-forward, BP-7 screenshot for a new App Store product.

const PERSONAL = { tenant_kind: 'PERSONAL', sales_model: 'SELF_SERVICE' };
const BUSINESS = { tenant_kind: 'BUSINESS', sales_model: 'SELF_SERVICE' };
const SHOT = '019a1200-0000-7000-8000-0000000000aa';

const apple = { provider: 'APP_STORE' as const, interval: 'MONTH' as const, product_id: 'ai.aramo.sign.personal_standard.monthly' };
const play = { provider: 'GOOGLE_PLAY' as const, interval: 'MONTH' as const, product_id: 'ai.aramo.sign.personal_standard.monthly' };
const stripe = { provider: 'STRIPE' as const, interval: 'MONTH' as const, product_id: 'aramo_sign_personal_standard' };

describe('billing_products shape', () => {
  it('accepts a full Personal payload', () => {
    expect(billingProductsShapeErrors({ products: [stripe, apple, play], apple_review_screenshot_asset_id: SHOT })).toEqual([]);
  });
  it('accepts an empty product list (a plan sold on no channel)', () => {
    expect(billingProductsShapeErrors({ products: [] })).toEqual([]);
  });
  it('refuses unknown keys, bad providers, bad ids and repeats', () => {
    const errs = billingProductsShapeErrors({ products: [{ ...apple, extra: 1 }, { ...apple }, { provider: 'PAYPAL', interval: 'MONTH', product_id: 'x' }], foo: 1 });
    expect(errs.join('\n')).toMatch(/foo is not allowed/);
    expect(errs.join('\n')).toMatch(/extra is not allowed/);
    expect(errs.join('\n')).toMatch(/repeats a provider and interval/);
    expect(errs.join('\n')).toMatch(/provider must be STRIPE, APP_STORE or GOOGLE_PLAY/);
  });
  it('refuses a yearly Stripe product and a Stripe id with dots', () => {
    const errs = billingProductsShapeErrors({ products: [{ provider: 'STRIPE', interval: 'YEAR', product_id: 'a.b' }] }).join('\n');
    expect(errs).toMatch(/a Stripe product is MONTH/);
    expect(errs).toMatch(/must be a Stripe product id/);
  });
  it('refuses stop_selling of a channel the version also sells on', () => {
    expect(billingProductsShapeErrors({ products: [apple], stop_selling: ['APP_STORE'] }).join('\n')).toMatch(/also sells on/);
  });
  it('refuses a non-uuid screenshot id', () => {
    expect(billingProductsShapeErrors({ products: [], apple_review_screenshot_asset_id: 'x' }).join('\n')).toMatch(/must be a uuid/);
  });
});

describe('eligibility (BP-2)', () => {
  it('Personal self-service sells on all three channels', () => expect(eligibleProviders(PERSONAL)).toEqual(['STRIPE', 'APP_STORE', 'GOOGLE_PLAY']));
  it('Business self-service sells on the web only', () => expect(eligibleProviders(BUSINESS)).toEqual(['STRIPE']));
  it('contract, enterprise and operator plans have no billing product', () => {
    expect(eligibleProviders({ tenant_kind: 'BUSINESS', sales_model: 'CONTACT_SALES' })).toEqual([]);
    expect(eligibleProviders({ tenant_kind: null, sales_model: 'OPERATOR' })).toEqual([]);
    expect(eligibleProviders({ tenant_kind: 'PERSONAL', sales_model: 'FREE' })).toEqual([]);
  });
});

describe('default ids (BP-3)', () => {
  it('reproduces the adopted App Store id for Personal Standard', () => {
    expect(planSlug('aramo-sign-standard-personal-v1')).toBe('personal_standard');
    expect(defaultProductId('APP_STORE', 'aramo-sign-standard-personal-v1', 'MONTH')).toBe('ai.aramo.sign.personal_standard.monthly');
    expect(defaultProductId('GOOGLE_PLAY', 'aramo-sign-standard-personal-v1', 'YEAR')).toBe('ai.aramo.sign.personal_standard.yearly');
    expect(defaultProductId('STRIPE', 'aramo-sign-standard-business-v1', 'MONTH')).toBe('aramo_sign_business_standard');
  });
});

describe('publish rules', () => {
  const base = (payload: BillingProductsPayload, over: Partial<Parameters<typeof billingProductsRuleErrors>[0]> = {}) =>
    billingProductsRuleErrors({ payload, plan: PERSONAL, existing: [], taken_elsewhere: [], sold: [], ...over }).map((e) => e.code);

  it('passes a first Personal publish with a screenshot', () => {
    expect(base({ products: [stripe, apple, play], apple_review_screenshot_asset_id: SHOT })).toEqual([]);
  });
  it('BP-7: a new App Store product needs the screenshot; an existing one does not', () => {
    expect(base({ products: [apple] })).toEqual(['SCREENSHOT_REQUIRED']);
    expect(base({ products: [apple] }, { existing: [apple] })).toEqual([]);
  });
  it('BP-2: a Business plan cannot sell in the apps', () => {
    expect(billingProductsRuleErrors({ payload: { products: [stripe, play] }, plan: BUSINESS, existing: [], taken_elsewhere: [], sold: [] }).map((e) => e.code)).toEqual(['PROVIDER_NOT_ELIGIBLE']);
  });
  it('BP-3: a permanent id cannot change, and an id of another plan is refused', () => {
    expect(base({ products: [{ ...play, product_id: 'other.id' }] }, { existing: [play] })).toEqual(['PRODUCT_ID_PERMANENT']);
    expect(base({ products: [play] }, { taken_elsewhere: [play] })).toEqual(['PRODUCT_ID_TAKEN']);
  });
  it('BP-11: a sold channel must be carried forward or explicitly stopped', () => {
    expect(base({ products: [stripe] }, { existing: [stripe, play], sold: [{ provider: 'STRIPE', interval: 'MONTH' }, { provider: 'GOOGLE_PLAY', interval: 'MONTH' }] })).toEqual(['CHANNEL_DROPPED']);
    expect(base({ products: [stripe], stop_selling: ['GOOGLE_PLAY'] }, { existing: [stripe, play], sold: [{ provider: 'STRIPE', interval: 'MONTH' }, { provider: 'GOOGLE_PLAY', interval: 'MONTH' }] })).toEqual([]);
  });
});
