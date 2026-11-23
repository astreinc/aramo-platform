import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BillingAccount } from '../api';

import { PersonalPlanPanel } from './PersonalPlan';

// Aramo-Sign-Catalog-v2-Pricing-and-Features-Directive-v1_0-LOCKED §4.3/§4.4 — the Personal plan
// page: Free details (no templates), the in-place upgrade to Standard ($10/month, 25 a month, no
// daily limit, 12-month commitment) through the server-issued Stripe checkout, the backend as the
// only authority after a checkout return, and the unsold "Coming soon" list.

const FREE_KEY = 'aramo-sign-free-personal-v1';
const STANDARD_KEY = 'aramo-sign-standard-personal-v1';

function free(over: Partial<BillingAccount> = {}): BillingAccount {
  return {
    subscription: {
      plan_key: FREE_KEY, plan_name: 'Free Personal', source: 'FREE', status: 'ACTIVE', sending: true, started_at: '2026-10-31T00:00:00Z', ended_at: null, current_period_end: null, cancel_at_period_end: false, grace_until: null, billing_managed: false,
    },
    allowance: {
      subscribed: true, plan_key: FREE_KEY, allowance_key: 'sign.envelopes', limit: 5, used: 2, remaining: 3, period_start: '2026-10-31T00:00:00Z', period_end: '2026-11-30T00:00:00Z', threshold: 'OK',
      daily: { limit: 2, used: 1 },
    },
    billing_available: true,
    tenant_kind: 'PERSONAL',
    self_service_eligible: false,
    can_manage_billing: true,
    upgrade: { available: true, plan_key: STANDARD_KEY, price_minor: 1000, commitment_months: 12 },
    storage: { capacity_key: 'sign.storage_bytes', limit: 15 * 1024 * 1024, unlimited: false, used: 0 },
    ...over,
  };
}

const STANDARD: BillingAccount = free({
  subscription: {
    plan_key: STANDARD_KEY, plan_name: 'Standard', source: 'SELF_SERVICE', status: 'ACTIVE', sending: true, started_at: '2026-10-31T00:00:00Z', ended_at: null, current_period_end: '2026-11-30T00:00:00Z', cancel_at_period_end: false, grace_until: null, billing_managed: true,
    commitment_months: 12, commitment_end: '2027-10-31T00:00:00Z', list_price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' },
  },
  allowance: { subscribed: true, plan_key: STANDARD_KEY, allowance_key: 'sign.envelopes', limit: 25, used: 4, remaining: 21, period_start: '2026-10-31T00:00:00Z', period_end: '2026-11-30T00:00:00Z', threshold: 'OK', daily: null },
  upgrade: null,
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(accounts: BillingAccount[], extra: (url: string) => Response | undefined = () => undefined) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const x = extra(url);
    if (x !== undefined) return x;
    if (url.endsWith('/v1/sign/billing/account')) return json(accounts[Math.min(i++, accounts.length - 1)]);
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  });
}

describe('PersonalPlanPanel', () => {
  const assign = vi.fn();
  beforeEach(() => {
    configureAuthConsumer('sign');
    vi.stubGlobal('location', { ...window.location, search: '', assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
  });

  const TERMS = { version: '1.0', url: 'https://legal.aramo.test/sign-personal-terms-1.0' };
  // C3 (audit row 16) — the plans' facts come from the catalog (GET /v1/sign/billing/plans) only.
  const CATALOG = [
    { key: FREE_KEY, name: 'Free', allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 5, unlimited: false, period: 'MONTHLY', available: true }], capacities: [], features: [] },
    {
      key: STANDARD_KEY,
      name: 'Standard',
      allowances: [{ allowance_key: 'sign.envelopes', included_quantity: 25, unlimited: false, period: 'MONTHLY', available: true }],
      capacities: [{ capacity_key: 'sign.storage_bytes', limit: 1024 ** 3, unlimited: false, available: true }],
      features: [],
    },
  ];
  const plans = (url: string) => (url.endsWith('/v1/sign/billing/plans') ? json({ plans: CATALOG, terms: TERMS, sales_contact_url: null }) : undefined);
  const refusal = (status: number, code: string, reason: string) => json({ error: { code, message: 'refused', details: { reason } } }, status);

  it('Free: shows the free terms (no templates), the Standard offer and disclosure, and Coming soon; Upgrade needs "I agree" and sends accept_terms', async () => {
    const fetch = stub([free()], (url) => (url.endsWith('/v1/sign/billing/checkout') ? json({ url: 'https://checkout.stripe.test/cs_p' }, 201) : plans(url)));
    vi.stubGlobal('fetch', fetch);
    render(<PersonalPlanPanel />);
    await waitFor(() => expect(screen.getByTestId('personal-plan-free-terms')).toHaveTextContent('5 documents a month, up to 2 a day · 15 MB storage · templates aren’t included'));
    expect(await screen.findByTestId('personal-plan-upgrade')).toHaveTextContent('25 documents a month');
    // UAT BIL-11 — the same rows as the app's Account → Plan and usage.
    expect(screen.getByTestId('personal-plan-usage-month')).toHaveTextContent('This month · 2 of 5 used');
    expect(screen.getByTestId('personal-plan-usage-day')).toHaveTextContent('Last 24 hours · 1 of 2 used');
    const offer = screen.getByTestId('personal-plan-upgrade');
    expect(offer).toHaveTextContent('Upgrade to Standard');
    expect(offer).toHaveTextContent('$10/month');
    expect(offer).toHaveTextContent('25 documents a month');
    // C3 — "No daily limit" is not a catalog fact, so it is no longer printed.
    expect(offer).not.toHaveTextContent('No daily limit');
    expect(offer).toHaveTextContent('1 GB storage');
    const disclosure = screen.getByTestId('personal-plan-upgrade-terms');
    expect(disclosure).toHaveTextContent('$10/month, 12-month commitment billed monthly');
    expect(disclosure).toHaveTextContent('Renews month to month after the commitment');
    expect(disclosure).toHaveTextContent('Cancel online in Settings, effective at the end of the commitment; no partial refunds');
    expect(disclosure).toHaveTextContent('You then return to Free');
    expect(offer.querySelector('s')).toBeNull();
    expect(screen.getByRole('link', { name: 'Create a Business organization' })).toHaveAttribute('href', '/signup');
    expect(screen.getByTestId('plans-coming-soon')).toHaveTextContent('Templates');
    expect(await screen.findByTestId('personal-plan-terms-link')).toHaveAttribute('href', TERMS.url);
    expect(screen.getByTestId('personal-plan-terms')).toHaveTextContent('(version 1.0)');
    const btn = screen.getByTestId('personal-plan-upgrade-btn');
    expect(btn).toBeDisabled();
    fireEvent.click(screen.getByTestId('personal-plan-terms-agree'));
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/cs_p'));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/checkout'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ plan_key: STANDARD_KEY, accept_terms: true });
  });

  it('C3 (audit row 16) — without catalog data the page prints no plan number from code', async () => {
    const bare = (url: string) => (url.endsWith('/v1/sign/billing/plans') ? json({ plans: [], terms: TERMS, sales_contact_url: null }) : undefined);
    vi.stubGlobal('fetch', stub([free({ upgrade: { available: true, plan_key: STANDARD_KEY, price_minor: null, commitment_months: null }, storage: null })], bare));
    render(<PersonalPlanPanel />);
    const offer = await screen.findByTestId('personal-plan-upgrade');
    await screen.findByTestId('personal-plan-terms-link');
    expect(offer).not.toHaveTextContent(/\$|documents a month|storage/);
    // The account's own allowance is server data and still shows.
    expect(screen.getByTestId('personal-plan-free-terms')).toHaveTextContent('5 documents a month, up to 2 a day');
  });

  it('upgrade: null (feature off) hides the upgrade card entirely', async () => {
    vi.stubGlobal('fetch', stub([free({ upgrade: null })], plans));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-free-terms')).toBeInTheDocument();
    expect(screen.queryByTestId('personal-plan-upgrade')).toBeNull();
    expect(screen.getByTestId('plans-coming-soon')).toBeInTheDocument();
  });

  it('an unavailable upgrade shows its reason and no checkout button', async () => {
    vi.stubGlobal('fetch', stub([free({ upgrade: { available: false, plan_key: STANDARD_KEY, price_minor: 1000, commitment_months: 12, reason: 'not_available_in_country' } })], plans));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-upgrade-unavailable')).toHaveTextContent('Standard isn’t available in your country yet.');
    expect(screen.queryByTestId('personal-plan-upgrade-btn')).toBeNull();
    expect(screen.queryByTestId('personal-plan-terms-agree')).toBeNull();
  });

  it.each([
    [400, 'VALIDATION_ERROR', 'TERMS_NOT_ACCEPTED', 'Check “I agree” to accept the terms before you continue.'],
    [403, 'FORBIDDEN', 'personal_paid_checkout_not_enabled', 'Upgrading to Standard isn’t available yet.'],
    [409, 'ESIGN_BILLING_CONFLICT', 'personal_paid_us_only', 'Standard isn’t available in your country yet.'],
  ])('a %i %s refusal (%s) is explained, not a crash', async (status, code, reason, text) => {
    vi.stubGlobal('fetch', stub([free()], (url) => (url.endsWith('/v1/sign/billing/checkout') ? refusal(status, code, reason) : plans(url))));
    render(<PersonalPlanPanel />);
    fireEvent.click(await screen.findByTestId('personal-plan-terms-agree'));
    fireEvent.click(screen.getByTestId('personal-plan-upgrade-btn'));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByTestId('personal-plan-upgrade-btn')).toBeEnabled();
  });

  it('Standard: the plan, its commitment and Manage billing; no daily limit line; no upgrade offer', async () => {
    vi.stubGlobal('fetch', stub([STANDARD], (url) => (url.endsWith('/v1/sign/billing/portal') ? json({ url: 'https://billing.stripe.test/p' }, 201) : undefined)));
    render(<PersonalPlanPanel />);
    const current = await screen.findByTestId('personal-plan-current');
    expect(current).toHaveTextContent('Standard · $10/month');
    expect(screen.getByTestId('personal-plan-commitment')).toHaveTextContent('12-month commitment, billed monthly');
    expect(screen.getByTestId('personal-plan-usage-month')).toHaveTextContent('This month · 4 of 25 used');
    expect(screen.queryByTestId('personal-plan-usage-day')).toBeNull();
    expect(screen.queryByTestId('personal-plan-upgrade')).toBeNull();
    expect(screen.getByTestId('personal-plan-manage')).toHaveTextContent('Manage billing or cancel');
    fireEvent.click(screen.getByTestId('personal-plan-manage'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://billing.stripe.test/p'));
  });

  it('a checkout return never asserts the upgrade: it waits until the backend reports the new plan', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?checkout=success', assign });
    vi.stubGlobal('fetch', stub([free(), STANDARD]));
    render(<PersonalPlanPanel pollMs={10} />);
    expect(await screen.findByTestId('personal-plan-confirming')).toHaveTextContent('Confirming your upgrade with Aramo');
    await waitFor(() => expect(screen.getByTestId('personal-plan-current')).toHaveTextContent('Standard · $10/month'));
    expect(screen.queryByTestId('personal-plan-confirming')).toBeNull();
  });

  it('a checkout cancel says so and charges nothing', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?checkout=canceled', assign });
    vi.stubGlobal('fetch', stub([free()], plans));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-canceled')).toHaveTextContent('Checkout was canceled. You haven’t been charged.');
    expect(screen.queryByTestId('personal-plan-confirming')).toBeNull();
  });

  it('Manage billing on a commitment plan: 503 PORTAL_NOT_CONFIGURED points to support', async () => {
    vi.stubGlobal('fetch', stub([STANDARD], (url) => (url.endsWith('/v1/sign/billing/portal') ? refusal(503, 'ESIGN_BILLING_UNAVAILABLE', 'PORTAL_NOT_CONFIGURED') : undefined)));
    render(<PersonalPlanPanel />);
    fireEvent.click(await screen.findByTestId('personal-plan-manage'));
    expect(await screen.findByText('Billing management will be available soon; contact support@aramo.ai.')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('Remaining-Work A4 — a requested cancel says when Standard ends and that the account returns to Free', async () => {
    vi.stubGlobal('fetch', stub([free({ ...STANDARD, subscription: { ...STANDARD.subscription!, cancel_at_period_end: true } })]));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-cancel')).toHaveTextContent('Standard ends on');
    expect(screen.getByTestId('personal-plan-cancel')).toHaveTextContent('returns to the Free plan');
  });

  // India Billing Regions + Razorpay (directive v1.0 §4.11) — an India resident (region ON) sees the INR
  // price and the auto-pay mandate disclosure BEFORE the redirect; a Razorpay-billed plan has no provider
  // portal: the Aramo manage section replaces "Manage billing or cancel".
  it('India: the INR offer shows ₹ and the Razorpay auto-pay mandate disclosure before checkout', async () => {
    const fetch = stub([free({ upgrade: { available: true, plan_key: STANDARD_KEY, price_minor: 89900, commitment_months: 12, currency: 'INR', billing_gateway: 'RAZORPAY' } })], (url) =>
      url.endsWith('/v1/sign/billing/checkout') ? json({ url: 'https://rzp.io/i/sub_test' }, 201) : plans(url),
    );
    vi.stubGlobal('fetch', fetch);
    render(<PersonalPlanPanel />);
    const offer = await screen.findByTestId('personal-plan-upgrade');
    expect(offer).toHaveTextContent('₹899/month');
    expect(offer).not.toHaveTextContent('$');
    expect(await screen.findByTestId('personal-plan-checkout-page')).toHaveTextContent('You’ll approve a monthly auto-pay mandate (UPI, card or net banking) on Razorpay’s secure page.');
    fireEvent.click(screen.getByTestId('personal-plan-terms-agree'));
    fireEvent.click(screen.getByTestId('personal-plan-upgrade-btn'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://rzp.io/i/sub_test'));
  });

  it('US: the checkout line names no provider', async () => {
    vi.stubGlobal('fetch', stub([free()], plans));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-checkout-page')).toHaveTextContent('Enter payment details on the secure checkout page.');
    expect(screen.getByTestId('personal-plan-upgrade')).not.toHaveTextContent('Stripe');
  });

  it('a Razorpay-billed Standard plan: ₹ price, the Aramo manage section, no provider portal button', async () => {
    const rzp = free({ ...STANDARD, managed_by: 'RAZORPAY', display_price: { amount_minor: 89900, currency: 'INR', interval: 'MONTH' } });
    vi.stubGlobal('fetch', stub([rzp]));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-current')).toHaveTextContent('Standard · ₹899/month');
    expect(screen.getByTestId('personal-plan-manage-razorpay')).toHaveTextContent('Manage subscription');
    expect(screen.queryByTestId('personal-plan-manage')).toBeNull();
  });
});

describe('PersonalPlanPanel — Monthly and Annual billing terms', () => {
  const assign = vi.fn();
  beforeEach(() => {
    configureAuthConsumer('sign');
    vi.stubGlobal('location', { ...window.location, search: '', assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
  });
  const TERMS = { version: '1.0', url: 'https://legal.aramo.test/sign-personal-terms-1.0' };
  const plans = (url: string) => (url.endsWith('/v1/sign/billing/plans') ? json({ plans: [], terms: TERMS, sales_contact_url: null }) : undefined);

  it('the Standard offer with two terms: Monthly by default, Annual on choice, and checkout sends the term', async () => {
    const offer = {
      available: true, plan_key: STANDARD_KEY, price_minor: 1200, commitment_months: null,
      billing_terms: [
        { term: 'MONTHLY' as const, price: { amount_minor: 1200, currency: 'USD', interval: 'MONTH' as const }, commitment_months: null, default: true, purchasable: true, web_only: false },
        { term: 'ANNUAL_COMMIT' as const, price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' as const }, commitment_months: 12, default: false, purchasable: true, web_only: true },
      ],
    };
    const fetch = stub([free({ upgrade: offer })], (url) => (url.endsWith('/v1/sign/billing/checkout') ? json({ url: 'https://checkout.stripe.test/cs_a' }, 201) : plans(url)));
    vi.stubGlobal('fetch', fetch);
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-terms-choice')).toHaveTextContent('Save $2/month (17%)');
    expect(screen.getByTestId('personal-plan-upgrade-terms')).toHaveTextContent('$12/month, billed monthly with no commitment. Cancel anytime');
    fireEvent.click(screen.getByRole('radio', { name: /Annual/ }));
    expect(screen.getByTestId('personal-plan-upgrade-terms')).toHaveTextContent('$10/month, 12-month commitment billed monthly. After the commitment it continues month to month at the Monthly price ($12/month)');
    fireEvent.click(await screen.findByTestId('personal-plan-terms-agree'));
    fireEvent.click(screen.getByTestId('personal-plan-upgrade-btn'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/cs_a'));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/checkout'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ plan_key: STANDARD_KEY, accept_terms: true, term: 'ANNUAL_COMMIT' });
  });
});

// CCP-PERSONAL-ARRANGED-1 P-7 (copy from @aramo/sign-client, PO ruling D-8).
describe('PersonalPlanPanel — a plan arranged with Aramo', () => {
  const assign = vi.fn();
  beforeEach(() => {
    configureAuthConsumer('sign');
    vi.stubGlobal('location', { ...window.location, search: '', assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
  });
  const TERMS = { version: '1.0', url: 'https://legal.aramo.test/sign-personal-terms-1.0' };
  const plans = (url: string) => (url.endsWith('/v1/sign/billing/plans') ? json({ plans: [], terms: TERMS, sales_contact_url: null }) : undefined);
  // The server's account of an arranged row: no list price, commitment months or term (P-7 server half).
  const arranged = (over: Partial<NonNullable<BillingAccount['subscription']>> = {}, upgrade: BillingAccount['upgrade'] = null): BillingAccount =>
    free({
      subscription: {
        plan_key: STANDARD_KEY, plan_name: 'Standard', source: 'MANUAL', status: 'ACTIVE', sending: true, started_at: '2026-11-24T00:00:00Z', ended_at: null, current_period_end: null, cancel_at_period_end: false, grace_until: null, billing_managed: false,
        arranged: true, commitment_months: null, term: null, commitment_end: null, list_price: null,
        ...over,
      },
      allowance: { subscribed: true, plan_key: STANDARD_KEY, allowance_key: 'sign.envelopes', limit: 25, used: 4, remaining: 21, period_start: '2026-11-24T00:00:00Z', period_end: '2026-12-24T00:00:00Z', threshold: 'OK', daily: null },
      upgrade,
    });

  it('COMP: "Standard · arranged with Aramo" with the Standard allowance; no price, commitment, term, billing text, manage or cancel; no offer', async () => {
    vi.stubGlobal('fetch', stub([arranged()], plans));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-arranged')).toHaveTextContent('Standard · arranged with Aramo');
    const current = screen.getByTestId('personal-plan-current');
    expect(current).not.toHaveTextContent(/\$|\/month|commitment|billed|Monthly/);
    expect(screen.getByTestId('personal-plan-usage-month')).toHaveTextContent('This month · 4 of 25 used');
    expect(screen.getByTestId('personal-plan-arranged-terms')).toHaveTextContent('25 documents a month');
    expect(screen.queryByTestId('personal-plan-commitment')).toBeNull();
    expect(screen.queryByTestId('personal-plan-term')).toBeNull();
    expect(screen.queryByTestId('personal-plan-manage')).toBeNull();
    expect(screen.queryByTestId('personal-plan-manage-razorpay')).toBeNull();
    expect(screen.queryByTestId('personal-plan-upgrade')).toBeNull();
    expect(screen.queryByTestId('personal-plan-free-terms')).toBeNull();
  });

  it('AGREED: a commitment end the row carries is still not shown, nor any billing control', async () => {
    vi.stubGlobal('fetch', stub([arranged({ commitment_end: '2027-11-24T00:00:00Z', billing_managed: true, cancel_at_period_end: true, current_period_end: '2026-12-24T00:00:00Z' })], plans));
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-arranged')).toHaveTextContent('Standard · arranged with Aramo');
    expect(screen.queryByTestId('personal-plan-commitment')).toBeNull();
    expect(screen.queryByTestId('personal-plan-cancel')).toBeNull();
    expect(screen.queryByTestId('personal-plan-manage')).toBeNull();
    expect(screen.queryByTestId('billing-cancel-open')).toBeNull();
    expect(screen.queryByTestId('billing-cancel-unavailable')).toBeNull();
    expect(screen.getByTestId('personal-plan-current')).not.toHaveTextContent(/commitment|Cancel/);
  });
});
