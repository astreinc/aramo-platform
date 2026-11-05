// M-A12 W1-G (A1) — the Plans model: server plans only, store-mapped intervals, the
// availability gate, the refusal copy and the AI hold.
import {
  blockCopy,
  featureLines,
  initialPlanKey,
  intervals,
  MANAGE_ON_WEB,
  planAction,
  PLANS_COPY,
  productFor,
  reasonLine,
  showIntervalToggle,
  STORE_NOTE,
  storeBillingAvailable,
  visiblePlans,
} from '../plansModel';
import { account, plan } from './plansFixtures';

describe('plans', () => {
  it('shows only active self-service and free plans, never contact-sales or operator', () => {
    const list = visiblePlans([
      plan('free'),
      plan('standard'),
      plan('enterprise', { sales_model: 'CONTACT_SALES' }),
      plan('ops', { sales_model: 'OPERATOR' }),
      plan('old', { status: 'INACTIVE' }),
    ]);
    expect(list.map((p) => p.key)).toEqual(['free', 'standard']);
  });

  it('opens on the plan above the current one', () => {
    expect(initialPlanKey([plan('free'), plan('standard')], account())).toBe('standard');
  });

  it('the interval toggle appears only when MONTH and YEAR both exist for the platform', () => {
    const p = plan('standard');
    expect(intervals(p, 'ios')).toEqual(['MONTH', 'YEAR']);
    expect(showIntervalToggle(p, 'ios')).toBe(true);
    expect(intervals(p, 'android')).toEqual(['MONTH']);
    expect(showIntervalToggle(p, 'android')).toBe(false);
    expect(productFor(p, 'ios', 'YEAR')?.product_id).toBe('std.year.ios');
  });

  it('features come from the catalog: available only, and never an AI feature (D-4)', () => {
    const lines = featureLines(plan('standard'));
    expect(lines).toContain('Unlimited sends');
    expect(lines).toContain('Unlimited templates');
    expect(lines).toContain('Custom domain');
    expect(lines.join(' ')).not.toMatch(/\bAI\b|ai assist/i);
  });

  it('store billing is on only when the server says so', () => {
    expect(storeBillingAvailable(account({ store_purchase_eligible: false }), [plan('free')])).toBe(false);
    expect(storeBillingAvailable(account({ store_purchase_eligible: true }), [])).toBe(true);
    expect(storeBillingAvailable(account({ store_purchase_eligible: false }), [plan('standard')])).toBe(true);
  });
});

describe('refusals and actions', () => {
  it('maps every block reason', () => {
    expect(blockCopy('not_billing_manager')).toBe(PLANS_COPY.askAdmin);
    expect(blockCopy('store_purchase_seats_unsupported')).toMatch(MANAGE_ON_WEB);
    expect(blockCopy('billing_managed_elsewhere')).toBe(PLANS_COPY.billedOnWeb);
    expect(blockCopy('billing_managed_elsewhere', account({ managed_by: 'GOOGLE_PLAY' }))).toBe(PLANS_COPY.billedInOtherStore);
    expect(blockCopy('store_billing_disabled')).toMatch(MANAGE_ON_WEB);
    expect(blockCopy(null)).toBeNull();
  });

  it('buy only with store billing on, no block, a mapped product and a store price', () => {
    const p = plan('standard');
    const product = productFor(p, 'ios', 'YEAR');
    expect(planAction({ plan: p, account: account(), storeOn: true, product, priced: true })).toEqual({ kind: 'buy', message: null });
    expect(planAction({ plan: p, account: account(), storeOn: false, product, priced: true })).toEqual({ kind: 'blocked', message: MANAGE_ON_WEB });
    expect(planAction({ plan: p, account: account({ store_purchase_block_reason: 'not_billing_manager' }), storeOn: true, product, priced: true }).message).toBe(PLANS_COPY.askAdmin);
    expect(planAction({ plan: p, account: account(), storeOn: true, product, priced: false }).message).toBe(PLANS_COPY.priceUnavailable);
    expect(planAction({ plan: plan('free'), account: account(), storeOn: true, product: null, priced: false }).kind).toBe('current');
  });

  it('the reason line and the platform renewal note', () => {
    expect(reasonLine('templates', [plan('free'), plan('standard')], null)).toBe('Templates come with Standard.');
    expect(reasonLine('home', [], 'You’ve used all 5 documents this month.')).toBe('You’ve used all 5 documents this month.');
    expect(reasonLine('settings', [], null)).toBe(PLANS_COPY.signingFree);
    expect(STORE_NOTE.ios).toMatch(/Apple Account/);
    expect(STORE_NOTE.android).toMatch(/Google Play › Subscriptions/);
  });
});
