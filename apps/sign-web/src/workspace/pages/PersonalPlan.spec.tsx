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
  const plans = (url: string) => (url.endsWith('/v1/sign/billing/plans') ? json({ plans: [], terms: TERMS, sales_contact_url: null }) : undefined);
  const refusal = (status: number, code: string, reason: string) => json({ error: { code, message: 'refused', details: { reason } } }, status);

  it('Free: shows the free terms (no templates), the Standard offer and disclosure, and Coming soon; Upgrade needs "I agree" and sends accept_terms', async () => {
    const fetch = stub([free()], (url) => (url.endsWith('/v1/sign/billing/checkout') ? json({ url: 'https://checkout.stripe.test/cs_p' }, 201) : plans(url)));
    vi.stubGlobal('fetch', fetch);
    render(<PersonalPlanPanel />);
    expect(await screen.findByTestId('personal-plan-free-terms')).toHaveTextContent('5 documents a month, up to 2 a day · 15 MB storage · templates aren’t included');
    expect(screen.getByTestId('personal-allowance-chip')).toHaveTextContent('3 of 5 left this month · 1 of 2 left today');
    const offer = screen.getByTestId('personal-plan-upgrade');
    expect(offer).toHaveTextContent('Upgrade to Standard');
    expect(offer).toHaveTextContent('$10/month');
    expect(offer).toHaveTextContent('25 documents a month');
    expect(offer).toHaveTextContent('No daily limit');
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
    expect(await screen.findByTestId('personal-plan-upgrade-unavailable')).toHaveTextContent('Standard is available to US residents for now.');
    expect(screen.queryByTestId('personal-plan-upgrade-btn')).toBeNull();
    expect(screen.queryByTestId('personal-plan-terms-agree')).toBeNull();
  });

  it.each([
    [400, 'VALIDATION_ERROR', 'TERMS_NOT_ACCEPTED', 'Check “I agree” to accept the terms before you continue.'],
    [403, 'FORBIDDEN', 'personal_paid_checkout_not_enabled', 'Upgrading to Standard isn’t available yet.'],
    [409, 'ESIGN_BILLING_CONFLICT', 'personal_paid_us_only', 'Standard is available to US residents for now.'],
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
    expect(screen.getByTestId('personal-allowance-chip')).toHaveTextContent('21 of 25 left this month');
    expect(screen.getByTestId('personal-allowance-chip')).not.toHaveTextContent('today');
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
});
