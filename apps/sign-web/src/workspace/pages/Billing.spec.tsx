import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { BillingAccount, BillingPlan } from '../api';

import { BillingPanel, checkoutReturn } from './Billing';

// Aramo Sign launch — Plan & billing. The backend decides plan, status, usage and
// who may buy; a return from checkout never asserts payment (the page waits for
// the backend); prices are never shown by Aramo. Journey A: an org admin with no
// Sign role yet gets the setup page instead of a dead end.

vi.mock('@aramo/document-templates-web/pdf', async (importOriginal) => ({ ...(await importOriginal<object>()), loadPdf: vi.fn() }));

const GiB = 1024 ** 3;
// `available` mirrors the backend availability registry: only envelopes,
// storage and team collaboration are built; forms, templates and AI assist are not.
const unl = (k: string) => ({ allowance_key: k, included_quantity: null, unlimited: true, period: 'MONTHLY', available: k === 'sign.envelopes' });
const feats = [
  { feature_key: 'sign.ai_assist_summary', enabled: true, available: false },
  { feature_key: 'sign.advanced_analytics', enabled: false, available: false },
  { feature_key: 'sign.team_collaboration', enabled: true, available: true },
  { feature_key: 'sign.custom_domain', enabled: false, available: false },
];
const caps = (storage: number) => [
  { capacity_key: 'sign.templates', limit: null, unlimited: true, available: false },
  { capacity_key: 'sign.storage_bytes', limit: storage, unlimited: false, available: true },
];
const BUSINESS: BillingPlan = {
  key: 'aramo-sign-standard-business-v1', name: 'Standard Business', description: null, tenant_kind: 'BUSINESS', sales_model: 'SELF_SERVICE', status: 'ACTIVE',
  price: { amount_minor: 2000, currency: 'USD', interval: 'MONTH' }, reference_price: null, commitment_months: 12, eligibility: null, eligible: true, support_tier: 'BASIC', activation_note: null,
  allowances: [unl('sign.envelopes'), unl('sign.forms')], capacities: caps(10 * GiB),
  features: feats, purchasable: true,
};
const PRO: BillingPlan = { ...BUSINESS, key: 'aramo-sign-standard-professional-v1', name: 'Standard Professional', price: { amount_minor: 1500, currency: 'USD', interval: 'MONTH' }, eligibility: 'ATS_SUBSCRIPTION', eligible: false, purchasable: false, capacities: caps(25 * GiB) };
const ENTERPRISE: BillingPlan = { ...BUSINESS, key: 'aramo-sign-enterprise-v1', name: 'Enterprise', sales_model: 'CONTACT_SALES', price: null, commitment_months: null, support_tier: 'CONTRACTED', allowances: [], capacities: [], features: [], purchasable: false };
const FREE: BillingPlan = { ...BUSINESS, key: 'aramo-sign-free-personal-v1', name: 'Free Personal', tenant_kind: 'PERSONAL', sales_model: 'FREE', status: 'INACTIVE', purchasable: false };
const CATALOG = { plans: [FREE, BUSINESS, PRO, ENTERPRISE], terms: null, sales_contact_url: null };
const PLAN = BUSINESS;

function account(over: Partial<BillingAccount> = {}): BillingAccount {
  return {
    subscription: null,
    allowance: { subscribed: false, allowance_key: 'sign.envelopes', state: 'NONE' },
    billing_available: true,
    tenant_kind: 'BUSINESS',
    self_service_eligible: true,
    can_manage_billing: true,
    ...over,
  };
}
const ACTIVE = account({
  subscription: {
    plan_key: PLAN.key, plan_name: PLAN.name, source: 'SELF_SERVICE', status: 'ACTIVE', sending: true, started_at: '2026-10-18T00:00:00Z', ended_at: null, current_period_end: '2026-11-18T00:00:00Z', cancel_at_period_end: false, grace_until: null, billing_managed: true,
    commitment_months: 12, commitment_end: '2027-10-18T00:00:00Z', cancel_requested_within_commitment: false, eligibility_state: null, list_price: { amount_minor: 2000, currency: 'USD', interval: 'MONTH' }, features: feats, export_access_until: null,
  },
  allowance: { subscribed: true, plan_key: PLAN.key, allowance_key: 'sign.envelopes', limit: null, unlimited: true, used: 185, remaining: null, period_start: '2026-10-18T00:00:00Z', period_end: '2026-11-18T00:00:00Z', threshold: 'OK' },
  storage: { capacity_key: 'sign.storage_bytes', limit: 10 * GiB, unlimited: false, used: 2 * GiB },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let catalogFor = () => CATALOG as unknown;

function stub(accounts: BillingAccount[], extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const x = extra(url, init);
    if (x !== undefined) return x;
    if (url.endsWith('/v1/sign/billing/account')) return json(accounts[Math.min(i++, accounts.length - 1)]);
    if (url.endsWith('/v1/sign/billing/plans')) return json(catalogFor());
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  });
}

describe('BillingPanel', () => {
  const assign = vi.fn();
  beforeEach(() => {
    configureAuthConsumer('sign');
    vi.stubGlobal('location', { ...window.location, search: '', assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
  });

  // India Billing Regions + Razorpay (directive v1.0 §4.11) — a Razorpay region: the regional INR price
  // (display_price), the auto-pay mandate disclosure before the redirect; a Razorpay-billed subscription
  // has the Aramo manage section and no provider portal button.
  it('India: a Razorpay region shows the ₹ display price and the auto-pay mandate before checkout', async () => {
    catalogFor = () => ({ ...CATALOG, plans: [{ ...BUSINESS, display_price: { amount_minor: 149900, currency: 'INR', interval: 'MONTH' } }], billing_gateway: 'RAZORPAY', billing_currency: 'INR' });
    vi.stubGlobal('fetch', stub([account()], (url) => (url.endsWith('/v1/sign/billing/checkout') ? json({ url: 'https://rzp.io/i/sub_b' }, 201) : undefined)));
    render(<BillingPanel />);
    const card = await screen.findByTestId(`billing-plan-${BUSINESS.key}`);
    expect(card).toHaveTextContent('₹1,499/month');
    expect(card).not.toHaveTextContent('$20');
    expect(screen.getByTestId(`billing-checkout-page-${BUSINESS.key}`)).toHaveTextContent('You’ll approve a monthly auto-pay mandate (UPI, card or net banking) on Razorpay’s secure page.');
    fireEvent.click(screen.getByTestId(`billing-subscribe-${BUSINESS.key}`));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://rzp.io/i/sub_b'));
    catalogFor = () => CATALOG;
  });

  it('US: the checkout line names no provider', async () => {
    vi.stubGlobal('fetch', stub([account()]));
    render(<BillingPanel />);
    expect(await screen.findByTestId(`billing-checkout-page-${BUSINESS.key}`)).toHaveTextContent('Enter payment details on the secure checkout page.');
    expect(screen.getByTestId(`billing-plan-${BUSINESS.key}`)).toHaveTextContent('$20/month');
  });

  it('a Razorpay-billed subscription: the Aramo manage section, no provider portal button', async () => {
    vi.stubGlobal('fetch', stub([account({ ...ACTIVE, managed_by: 'RAZORPAY', display_price: { amount_minor: 149900, currency: 'INR', interval: 'MONTH' } })]));
    render(<BillingPanel />);
    expect(await screen.findByTestId('billing-manage-razorpay')).toHaveTextContent('Manage subscription');
    expect(screen.queryByTestId('billing-manage')).toBeNull();
    expect(screen.getByTestId('billing-current')).toHaveTextContent('₹1,499/month');
  });

  it('no plan: the business catalog with prices, commitment and features; Subscribe goes to the server-issued checkout', async () => {
    const fetch = stub([account()], (url) => (url.endsWith('/v1/sign/billing/checkout') ? json({ url: 'https://checkout.stripe.test/cs_1' }, 201) : undefined));
    vi.stubGlobal('fetch', fetch);
    render(<BillingPanel />);
    expect(await screen.findByTestId('billing-none')).toBeInTheDocument();
    const business = await screen.findByTestId(`billing-plan-${BUSINESS.key}`);
    expect(business).toHaveTextContent('$20/month per organization');
    expect(business).toHaveTextContent('12-month commitment, billed monthly · plus applicable tax');
    // Remaining-Work A1 — before purchase: what happens after the commitment and how a cancellation works.
    expect(screen.getAllByTestId('billing-plan-renewal')[0]).toHaveTextContent(
      'Your plan starts with a 12-month commitment, billed monthly. After that it continues month to month until you cancel in your billing settings; a cancellation takes effect at the end of the current monthly period.',
    );
    expect(business).toHaveTextContent('Unlimited E-Signs');
    expect(business).toHaveTextContent('10 GB storage');
    expect(business).toHaveTextContent('Team collaboration');
    // Entitled but not built: never advertised as delivered.
    expect(business).not.toHaveTextContent('forms');
    expect(business).not.toHaveTextContent('templates');
    expect(business).not.toHaveTextContent('AI assist');
    expect(business).not.toHaveTextContent('Advanced analytics');
    // Unsubstantiated comparison price is never shown.
    expect(business).not.toHaveTextContent('$30');
    // Free Personal is not offered to a business organization.
    expect(screen.queryByTestId(`billing-plan-${FREE.key}`)).toBeNull();
    // Catalog v2 P-1 — unbuilt features only in the separate, unsold "Coming soon" card.
    const soon = screen.getByTestId('plans-coming-soon');
    expect(soon).toHaveTextContent('Not included in any plan yet');
    expect(soon).toHaveTextContent('Templates');
    expect(soon).toHaveTextContent('Bulk send & bulk sign');
    expect(soon).toHaveTextContent('Recipient verification (SMS, ID, knowledge-based)');
    fireEvent.click(screen.getByTestId(`billing-subscribe-${BUSINESS.key}`));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/cs_1'));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/checkout'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ plan_key: BUSINESS.key });
  });

  it('Standard Professional without ATS shows the requirement and no Subscribe; Enterprise is contact sales', async () => {
    vi.stubGlobal('fetch', stub([account()]));
    render(<BillingPanel />);
    const pro = await screen.findByTestId(`billing-plan-${PRO.key}`);
    expect(pro).toHaveTextContent('$15/month');
    expect(pro).toHaveTextContent('25 GB storage');
    expect(screen.getByTestId('billing-plan-ineligible')).toHaveTextContent('Aramo ATS subscription');
    expect(screen.queryByTestId(`billing-subscribe-${PRO.key}`)).toBeNull();
    expect(screen.getByTestId(`billing-plan-${ENTERPRISE.key}`)).toHaveTextContent('Contact sales');
    expect(screen.getByTestId(`billing-plan-${ENTERPRISE.key}`).querySelector('[data-testid="billing-plan-renewal"]')).toBeNull();
  });

  it('no comparison (strikethrough) price is ever shown, even when the backend sends one (catalog v2 P-2); approved terms must be ticked before Subscribe', async () => {
    catalogFor = () => ({ ...CATALOG, plans: [{ ...BUSINESS, reference_price: { amount_minor: 3000, currency: 'USD' } }], terms: { version: '1.0.0', url: 'https://aramo.ai/legal/terms' } });
    const fetch = stub([account()], (url) => (url.endsWith('/checkout') ? json({ url: 'https://checkout.stripe.test/x' }, 201) : undefined));
    vi.stubGlobal('fetch', fetch);
    render(<BillingPanel />);
    const card = await screen.findByTestId(`billing-plan-${BUSINESS.key}`);
    expect(card.querySelector('s')).toBeNull();
    expect(card).not.toHaveTextContent('$30');
    const btn = screen.getByTestId(`billing-subscribe-${BUSINESS.key}`);
    expect(btn).toBeDisabled();
    // Remaining-Work A1 — the required checkbox names the Terms and the month-to-month continuation.
    expect(screen.getByTestId('billing-terms')).toHaveTextContent(
      'I agree to the Aramo Sign Terms of Service (version 1.0.0), including that my plan continues month to month after its commitment until I cancel.',
    );
    fireEvent.click(screen.getByTestId('billing-terms').querySelector('input')!);
    fireEvent.click(btn);
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/checkout'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ plan_key: BUSINESS.key, accept_terms: true });
    catalogFor = () => CATALOG;
  });

  it('active: usage, renewal, Manage billing; no second subscribe', async () => {
    vi.stubGlobal('fetch', stub([ACTIVE], (url) => (url.endsWith('/v1/sign/billing/portal') ? json({ url: 'https://billing.stripe.test/p' }, 201) : undefined)));
    render(<BillingPanel />);
    expect(await screen.findByText('185 envelopes sent this period · unlimited')).toBeInTheDocument();
    expect(screen.queryByTestId('billing-usage-meter')).toBeNull();
    expect(screen.getByText('2 GB of 10 GB storage used')).toBeInTheDocument();
    expect(screen.getByTestId('billing-commitment')).toHaveTextContent('12-month commitment, billed monthly');
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByTestId(`billing-subscribe-${BUSINESS.key}`)).toBeNull();
    expect(screen.getByTestId('billing-manage')).toHaveTextContent('Manage billing or cancel');
    fireEvent.click(screen.getByTestId('billing-manage'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://billing.stripe.test/p'));
  });

  it('Remaining-Work A4 — the owner of a self-service plan gets Cancel subscription when the backend offers it', async () => {
    const view = {
      product_key: 'sign', terms: { state: 'APPROVED', document_key: 'sign.terms_of_service', version: '2.0', url: 'https://legal.test/t' },
      subscription: { plan_key: PLAN.key, status: 'ACTIVE', current_period_end: '2027-10-18T12:00:00Z', cancel_at_period_end: false, commitment_end: '2027-10-18T12:00:00Z' },
      pending_provider: false, pending_changes: [], actions: { cancel: { available: true, reason: null }, upgrade: { available: false, reason: null } }, can_manage_billing: true,
    };
    const fetch = stub([ACTIVE], (url) =>
      url.endsWith('/v1/sign/billing/self-service') ? json(view) : url.endsWith('/v1/sign/billing/self-service/cancel') ? json({ request_id: 'r', action: 'CANCEL_AT_PERIOD_END', status: 'PENDING_PROVIDER', pending_provider: true, replayed: false }, 202) : undefined,
    );
    vi.stubGlobal('fetch', fetch);
    render(<BillingPanel />);
    fireEvent.click(await screen.findByTestId('billing-cancel-open'));
    expect(screen.getByTestId('billing-cancel-confirm')).toHaveTextContent('October 18, 2027');
    fireEvent.click(screen.getByTestId('billing-cancel-submit'));
    await waitFor(() => expect(fetch.mock.calls.some(([u, i]) => String(u).endsWith('/self-service/cancel') && (i as RequestInit | undefined)?.method === 'POST')).toBe(true));
  });

  it('a member without settings authority sees the plan but cannot buy or manage', async () => {
    vi.stubGlobal('fetch', stub([account({ ...ACTIVE, can_manage_billing: false })]));
    render(<BillingPanel />);
    expect(await screen.findByText('Only an organization admin can change the plan.')).toBeInTheDocument();
    expect(screen.queryByTestId('billing-manage')).toBeNull();
    expect(screen.queryByTestId(`billing-subscribe-${BUSINESS.key}`)).toBeNull();
  });

  it('an early cancellation inside the commitment and an eligibility lapse are both explained', async () => {
    vi.stubGlobal('fetch', stub([account({ ...ACTIVE, subscription: { ...ACTIVE.subscription!, cancel_at_period_end: true, cancel_requested_within_commitment: true, eligibility_state: 'LAPSED' } })]));
    render(<BillingPanel />);
    expect(await screen.findByTestId('billing-cancel')).toHaveTextContent('before the end of your 12-month commitment');
    expect(screen.getByTestId('billing-eligibility-lapsed')).toHaveTextContent('Sending continues');
  });

  it('past due within grace and past due after grace are explained; signing of sent envelopes continues', async () => {
    const pd = (sending: boolean) =>
      account({ ...ACTIVE, subscription: { ...ACTIVE.subscription!, status: 'PAST_DUE', sending, grace_until: '2026-10-25T00:00:00Z' }, ...(sending ? {} : { allowance: { subscribed: false, allowance_key: 'sign.envelopes', state: 'PAST_DUE' } }) });
    vi.stubGlobal('fetch', stub([pd(true)]));
    const { unmount } = render(<BillingPanel />);
    expect(await screen.findByText(/Sending continues until/)).toBeInTheDocument();
    unmount();
    vi.stubGlobal('fetch', stub([pd(false)]));
    render(<BillingPanel />);
    expect(await screen.findByText(/Envelopes already sent can still be signed/)).toBeInTheDocument();
  });

  it('returning from checkout waits for the backend, never the redirect', async () => {
    vi.stubGlobal('location', { ...window.location, search: '?checkout=success', assign });
    const onSending = vi.fn();
    vi.stubGlobal('fetch', stub([account(), account(), ACTIVE]));
    render(<BillingPanel onSending={onSending} pollMs={20} />);
    expect(await screen.findByTestId('billing-confirming')).toBeInTheDocument();
    expect(onSending).not.toHaveBeenCalled();
    await waitFor(() => expect(onSending).toHaveBeenCalled());
    expect(screen.queryByTestId('billing-confirming')).toBeNull();
  });

  it('checkoutReturn reads only the two known values', () => {
    expect(checkoutReturn('?checkout=success')).toBe('success');
    expect(checkoutReturn('?checkout=canceled')).toBe('canceled');
    expect(checkoutReturn('?checkout=paid')).toBeNull();
  });

  it('billing unavailable is a clear message', async () => {
    vi.stubGlobal('fetch', stub([account()], (url) => (url.endsWith('/checkout') ? json({ error: { code: 'ESIGN_BILLING_UNAVAILABLE', message: 'x' } }, 503) : undefined)));
    render(<BillingPanel />);
    fireEvent.click(await screen.findByTestId(`billing-subscribe-${BUSINESS.key}`));
    expect(await screen.findByText(/Online billing isn’t available right now/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('domain verification required (Domain-Enforcement P3 §4): the refusal message links to Settings → Domain', async () => {
    const refusal = {
      error: {
        code: 'ESIGN_BILLING_CONFLICT',
        message: 'Verify your organization’s email domain before subscribing. You can assign this to your IT administrator in Settings.',
        details: { reason: 'domain_verification_required' },
      },
    };
    vi.stubGlobal('fetch', stub([account()], (url) => (url.endsWith('/checkout') ? json(refusal, 409) : undefined)));
    render(<BillingPanel />);
    fireEvent.click(await screen.findByTestId(`billing-subscribe-${BUSINESS.key}`));
    const box = await screen.findByTestId('billing-domain-required');
    expect(box).toHaveTextContent('Verify your organization’s email domain before subscribing. You can assign this to your IT administrator in Settings.');
    expect(screen.getByTestId('billing-domain-settings-link')).toHaveAttribute('href', '/sign/settings/domain');
    // Not the generic billing-account message.
    expect(screen.queryByText(/doesn’t have a billing account yet/)).toBeNull();
    expect(assign).not.toHaveBeenCalled();
  });
});

// Sign Business per-seat directive (v1.0 LOCKED) §3.5 — per-user prices, seats and checkout seats.
describe('BillingPanel — per-seat plans', () => {
  const assign = vi.fn();
  const SEAT_PLAN: BillingPlan = { ...BUSINESS, key: 'aramo-sign-standard-business-v2', name: 'Standard Business', price: { amount_minor: 1500, currency: 'USD', interval: 'MONTH' }, price_unit: 'SEAT' };
  const SEAT_ACTIVE = (seats: BillingAccount['seats'], over: Partial<BillingAccount> = {}): BillingAccount => ({
    ...ACTIVE,
    subscription: { ...ACTIVE.subscription!, plan_key: SEAT_PLAN.key, list_price: { amount_minor: 1500, currency: 'USD', interval: 'MONTH' } },
    price_unit: 'SEAT',
    seats,
    can_manage_seats: true,
    ...over,
  });
  beforeEach(() => {
    configureAuthConsumer('sign');
    vi.stubGlobal('location', { ...window.location, search: '', assign });
    catalogFor = () => ({ ...CATALOG, plans: [BUSINESS, SEAT_PLAN] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
    catalogFor = () => CATALOG;
  });

  it('PS-1 a SEAT plan reads "$15 / user / month" (no "per organization"); a per-account plan keeps "per organization"', async () => {
    vi.stubGlobal('fetch', stub([account()]));
    render(<BillingPanel />);
    const seat = await screen.findByTestId(`billing-plan-${SEAT_PLAN.key}`);
    expect(seat.querySelector('[data-testid="billing-plan-price"] strong')).toHaveTextContent(/^\$15 \/ user \/ month$/);
    expect(seat).not.toHaveTextContent('per organization');
    expect(screen.getByTestId(`billing-plan-${BUSINESS.key}`)).toHaveTextContent('$20/month per organization');
  });

  it('PS-2 checkout of a SEAT plan asks for the seat count (default 1) and sends `seats`; a per-account plan sends none', async () => {
    const fetch = stub([account()], (url) => (url.endsWith('/v1/sign/billing/checkout') ? json({ url: 'https://checkout.stripe.test/cs_s' }, 201) : undefined));
    vi.stubGlobal('fetch', fetch);
    render(<BillingPanel />);
    const input = await screen.findByTestId(`billing-seats-${SEAT_PLAN.key}`);
    expect(input).toHaveValue(1);
    expect(screen.queryByTestId(`billing-seats-${BUSINESS.key}`)).toBeNull();
    fireEvent.change(input, { target: { value: '3' } });
    expect(screen.getByTestId(`billing-plan-${SEAT_PLAN.key}`)).toHaveTextContent('3 seats · $45/month');
    fireEvent.click(screen.getByTestId(`billing-subscribe-${SEAT_PLAN.key}`));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/cs_s'));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/checkout'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ plan_key: SEAT_PLAN.key, seats: 3 });
  });

  it('PS-3 an invalid seat count disables Subscribe', async () => {
    vi.stubGlobal('fetch', stub([account()]));
    render(<BillingPanel />);
    const input = await screen.findByTestId(`billing-seats-${SEAT_PLAN.key}`);
    for (const bad of ['0', '1001', '']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(screen.getByTestId(`billing-subscribe-${SEAT_PLAN.key}`)).toBeDisabled();
    }
  });

  it('PS-4 the current SEAT subscription shows "N of M seats used", the per-user price and the scheduled decrease', async () => {
    vi.stubGlobal('fetch', stub([SEAT_ACTIVE({ purchased: 5, used: 3, pending_purchased: 4 })]));
    render(<BillingPanel />);
    expect(await screen.findByTestId('billing-seats-used')).toHaveTextContent('3 of 5 seats used');
    expect(screen.getByTestId('billing-current')).toHaveTextContent('$15 / user / month');
    expect(screen.getByTestId('billing-seats-pending')).toHaveTextContent('Drops to 4 seats on');
    expect(screen.getByTestId('billing-seats-change')).toBeInTheDocument();
    // Not full: no "Add a seat" shortcut.
    expect(screen.queryByTestId('billing-seats-add')).toBeNull();
  });

  it('PS-5 Change seats posts the new count and confirms; Save stays disabled below the seats in use', async () => {
    const accounts = [SEAT_ACTIVE({ purchased: 5, used: 3, pending_purchased: null }), SEAT_ACTIVE({ purchased: 7, used: 3, pending_purchased: null })];
    const fetch = stub(accounts, (url) => (url.endsWith('/v1/sign/billing/seats') ? json({ purchased: 7, used: 3, pending_purchased: null, effective: 'NOW' }) : undefined));
    vi.stubGlobal('fetch', fetch);
    render(<BillingPanel />);
    fireEvent.click(await screen.findByTestId('billing-seats-change'));
    const dialog = screen.getByRole('dialog', { name: 'Change seats' });
    const input = screen.getByTestId('billing-seats-input');
    expect(input).toHaveValue(5);
    expect(input).toHaveAttribute('min', '3');
    expect(input).toHaveAttribute('max', '1000');
    expect(screen.getByTestId('billing-seats-save')).toBeDisabled();
    fireEvent.change(input, { target: { value: '2' } });
    expect(screen.getByTestId('billing-seats-save')).toBeDisabled();
    expect(dialog).toHaveTextContent('Enter a number from 3 to 1000.');
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.click(screen.getByTestId('billing-seats-save'));
    expect(await screen.findByTestId('billing-seats-notice')).toHaveTextContent('You now have 7 seats.');
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/v1/sign/billing/seats'))!;
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ seats: 7 });
    expect(await screen.findByText('3 of 7 seats used')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Change seats' })).toBeNull();
  });

  it('PS-6 at the limit "Add a seat" opens the dialog one above; a decrease confirms the period-end change', async () => {
    const fetch = stub([SEAT_ACTIVE({ purchased: 3, used: 3, pending_purchased: null })], (url) =>
      url.endsWith('/v1/sign/billing/seats') ? json({ purchased: 3, used: 3, pending_purchased: 3, effective: 'PERIOD_END' }) : undefined,
    );
    vi.stubGlobal('fetch', fetch);
    render(<BillingPanel />);
    fireEvent.click(await screen.findByTestId('billing-seats-add'));
    expect(screen.getByTestId('billing-seats-input')).toHaveValue(4);
    fireEvent.click(screen.getByTestId('billing-seats-save'));
    expect(await screen.findByTestId('billing-seats-notice')).toHaveTextContent('Your seats drop to 3 at the end of the current billing period.');
  });

  it('PS-7 409 seats_below_usage is explained in the dialog', async () => {
    const refusal = { error: { code: 'ESIGN_BILLING_CONFLICT', message: 'x', details: { reason: 'seats_below_usage', used: 4 } } };
    vi.stubGlobal('fetch', stub([SEAT_ACTIVE({ purchased: 6, used: 3, pending_purchased: null })], (url) => (url.endsWith('/v1/sign/billing/seats') ? json(refusal, 409) : undefined)));
    render(<BillingPanel />);
    fireEvent.click(await screen.findByTestId('billing-seats-change'));
    fireEvent.change(screen.getByTestId('billing-seats-input'), { target: { value: '3' } });
    fireEvent.click(screen.getByTestId('billing-seats-save'));
    expect(await screen.findByText('4 people are using seats, so you need at least 4 seats. Remove someone’s Aramo Sign access first to go lower.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Change seats' })).toBeInTheDocument();
  });

  it('PS-8 without can_manage_seats the seats show but cannot be changed', async () => {
    vi.stubGlobal('fetch', stub([SEAT_ACTIVE({ purchased: 3, used: 3, pending_purchased: null }, { can_manage_seats: false })]));
    render(<BillingPanel />);
    expect(await screen.findByTestId('billing-seats-used')).toHaveTextContent('3 of 3 seats used');
    expect(screen.queryByTestId('billing-seats-add')).toBeNull();
    expect(screen.queryByTestId('billing-seats-change')).toBeNull();
  });

  it('PS-9 a per-account subscription shows no seats', async () => {
    vi.stubGlobal('fetch', stub([{ ...ACTIVE, price_unit: 'ACCOUNT', seats: null, can_manage_seats: false }]));
    render(<BillingPanel />);
    await screen.findByText('185 envelopes sent this period · unlimited');
    expect(screen.queryByTestId('billing-seats')).toBeNull();
  });
});

describe('Journey A — organization owner without Sign access', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  const session = (scopes: string[]) => ({ sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes, iat: 0, exp: 9_999_999_999 });
  const app = (scopes: string[]) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/sign/session')) return json(session(scopes));
      if (url.endsWith('/v1/sign/sender/context')) return json({ error: { code: 'INSUFFICIENT_PERMISSIONS' } }, 403);
      if (url.endsWith('/v1/sign/billing/account')) return json(account());
      if (url.endsWith('/v1/sign/billing/plans')) return json(CATALOG);
      return json({ items: [] });
    });

  // ROLES-1 PR-2 (§3.4) — plan management is sign:billing:manage only (tenant_owner).
  it('the organization owner gets the setup page with the plan', async () => {
    vi.stubGlobal('fetch', app(['sign:billing:manage', 'tenant:admin:settings', 'tenant:admin:user-manage']));
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('state-setup')).toBeInTheDocument();
    expect(await screen.findByTestId(`billing-subscribe-${BUSINESS.key}`)).toBeInTheDocument();
  });

  it('organization settings authority alone no longer gets the setup page (ROLES-1 PR-2)', async () => {
    vi.stubGlobal('fetch', app(['tenant:admin:settings', 'tenant:admin:user-manage']));
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('state-no-access')).toBeInTheDocument();
  });

  it('anyone else still gets the no-access page', async () => {
    vi.stubGlobal('fetch', app([]));
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('state-no-access')).toBeInTheDocument();
  });
});

