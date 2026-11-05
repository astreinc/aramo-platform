// Plans fixtures for the M-A12 W1-G tests. Names and prices are test values: the app
// never hard-codes either (they come from the server and the store).
import type { Account, Plan } from '../plansModel';

export function plan(key: string, over: Partial<Plan> = {}): Plan {
  return {
    key,
    name: key === 'free' ? 'Free' : 'Standard',
    description: null,
    tenant_kind: 'PERSONAL',
    sales_model: key === 'free' ? 'FREE' : 'SELF_SERVICE',
    status: 'ACTIVE',
    price: null,
    reference_price: null,
    commitment_months: null,
    eligibility: null,
    eligible: true,
    allowances: [{ allowance_key: 'sign.envelopes', included_quantity: key === 'free' ? 5 : null, unlimited: key !== 'free', period: 'MONTHLY', available: true }],
    capacities: key === 'free' ? [] : [{ capacity_key: 'sign.templates', limit: null, unlimited: true, available: true }],
    features: [
      { feature_key: 'sign.ai_assist_summary', enabled: true, available: false },
      { feature_key: 'sign.ai_assist_summary', enabled: true, available: true },
      { feature_key: 'sign.custom_domain', enabled: true, available: true },
    ],
    purchasable: true,
    store_products:
      key === 'free'
        ? []
        : [
            { platform: 'ios', product_id: 'std.month.ios', interval: 'MONTH' },
            { platform: 'ios', product_id: 'std.year.ios', interval: 'YEAR' },
            { platform: 'android', product_id: 'std.month.android', interval: 'MONTH' },
          ],
    ...over,
  } as Plan;
}

export function account(over: Partial<Account> = {}): Account {
  return {
    tenant_kind: 'PERSONAL',
    can_manage_billing: true,
    self_service_eligible: true,
    billing_available: true,
    subscription: { plan_key: 'free', plan_name: 'Free', source: 'FREE', status: 'ACTIVE', ended_at: null },
    allowance: { limit: 5, used: 5, remaining: 0, period_end: '2026-12-01T00:00:00.000Z' },
    store_purchase_eligible: true,
    store_purchase_block_reason: null,
    managed_by: null,
    manage_url: null,
    ...over,
  } as unknown as Account;
}
