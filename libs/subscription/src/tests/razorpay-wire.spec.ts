import { describe, expect, it } from 'vitest';

import { razorpaySubscriptionState } from '../lib/billing/razorpay-billing.provider.js';
import { razorpayWireAccountPath, razorpayWireAccountRef, razorpayWireSubscriptionAccountFields } from '../lib/billing/razorpay-wire.js';

// India Billing Regions + Razorpay (directive v1.0 LOCKED §4.5) — boundary CONTRACT tests for the
// Razorpay wire translation (PO ruling 2026-11-13, §3 Q4: vendor names stay at the boundary; Aramo-owned
// shapes use account_ref). Vocabulary-exempt together with razorpay-wire.ts because the fixtures are
// Razorpay-shaped; no Aramo logic lives here.

const ARAMO_KEYS = ['provider', 'subscription_ref', 'account_ref', 'provider_status', 'current_period_start', 'current_period_end', 'cancel_at_period_end', 'price_ref', 'tenant_id', 'intent_id', 'account_country', 'item_ref', 'quantity'];

describe('Razorpay wire → Aramo', () => {
  it('reads the account id of a subscription (absent / null → empty)', () => {
    expect(razorpayWireAccountRef({ customer_id: 'cust_1' })).toBe('cust_1');
    expect(razorpayWireAccountRef({ customer_id: null })).toBe('');
    expect(razorpayWireAccountRef({})).toBe('');
  });

  it('a Razorpay subscription becomes an Aramo state with account_ref and no vendor key', () => {
    const s = razorpaySubscriptionState({ id: 'sub_1', customer_id: 'cust_1', status: 'active', plan_id: 'plan_1', current_start: 1, current_end: 2, quantity: 1, notes: { tenant_id: 't', intent_id: 'i' } });
    expect(s.account_ref).toBe('cust_1');
    expect(Object.keys(s).sort()).toEqual([...ARAMO_KEYS].sort());
    expect(JSON.stringify(s)).not.toMatch(/customer/);
  });
});

describe('Aramo → Razorpay wire', () => {
  it('a subscription create notifies the payer and binds the billing account only when one exists', () => {
    expect(razorpayWireSubscriptionAccountFields(null)).toEqual({ customer_notify: 1 });
    expect(razorpayWireSubscriptionAccountFields('')).toEqual({ customer_notify: 1 });
    expect(razorpayWireSubscriptionAccountFields('cust_1')).toEqual({ customer_notify: 1, customer_id: 'cust_1' });
  });

  it('the account path creates (null) or updates (the id, encoded)', () => {
    expect(razorpayWireAccountPath(null)).toBe('/v1/customers');
    expect(razorpayWireAccountPath('cust_1')).toBe('/v1/customers/cust_1');
    expect(razorpayWireAccountPath('a/b')).toBe('/v1/customers/a%2Fb');
  });
});
