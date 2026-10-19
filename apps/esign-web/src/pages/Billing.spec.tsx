import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../App';
import type { BillingAccount } from '../api';

import { BillingPanel, checkoutReturn } from './Billing';

// Aramo Sign launch — Plan & billing. The backend decides plan, status, usage and
// who may buy; a return from checkout never asserts payment (the page waits for
// the backend); prices are never shown by Aramo. Journey A: an org admin with no
// Sign role yet gets the setup page instead of a dead end.

vi.mock('../pdf', () => ({ loadPdf: vi.fn() }));

const PLAN = { key: 'aramo-sign-business-v1', name: 'Aramo Sign Business', description: '100 envelopes per month for your organization. Unused envelopes do not roll over.', allowances: [{ allowance_key: 'esign.envelopes', included_quantity: 100, period: 'MONTHLY' }], purchasable: true };

function account(over: Partial<BillingAccount> = {}): BillingAccount {
  return {
    subscription: null,
    allowance: { subscribed: false, allowance_key: 'esign.envelopes', state: 'NONE' },
    billing_available: true,
    tenant_kind: 'BUSINESS',
    self_service_eligible: true,
    can_manage_billing: true,
    ...over,
  };
}
const ACTIVE = account({
  subscription: { plan_key: PLAN.key, plan_name: PLAN.name, source: 'SELF_SERVICE', status: 'ACTIVE', sending: true, started_at: '2026-10-18T00:00:00Z', ended_at: null, current_period_end: '2026-11-18T00:00:00Z', cancel_at_period_end: false, grace_until: null, billing_managed: true },
  allowance: { subscribed: true, plan_key: PLAN.key, allowance_key: 'esign.envelopes', limit: 100, used: 85, remaining: 15, period_start: '2026-10-18T00:00:00Z', period_end: '2026-11-18T00:00:00Z', threshold: 'WARNING' },
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(accounts: BillingAccount[], extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  let i = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const x = extra(url, init);
    if (x !== undefined) return x;
    if (url.endsWith('/v1/esign/billing/account')) return json(accounts[Math.min(i++, accounts.length - 1)]);
    if (url.endsWith('/v1/esign/billing/plans')) return json({ plans: [PLAN] });
    return json({ error: { code: 'NOT_FOUND' } }, 404);
  });
}

describe('BillingPanel', () => {
  const assign = vi.fn();
  beforeEach(() => {
    configureAuthConsumer('esign');
    vi.stubGlobal('location', { ...window.location, search: '', assign });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    assign.mockReset();
  });

  it('no plan: shows the plan and its allowance (no price), and Subscribe goes to the server-issued checkout URL', async () => {
    const fetch = stub([account()], (url) => (url.endsWith('/v1/esign/billing/checkout') ? json({ url: 'https://checkout.stripe.test/cs_1' }, 201) : undefined));
    vi.stubGlobal('fetch', fetch);
    render(<BillingPanel />);
    expect(await screen.findByTestId('billing-none')).toBeInTheDocument();
    expect(await screen.findByText('100 envelopes')).toBeInTheDocument();
    expect(screen.queryByText(/\$|USD|€/)).toBeNull();
    fireEvent.click(screen.getByTestId('billing-subscribe'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/cs_1'));
    const call = fetch.mock.calls.find(([u]) => String(u).endsWith('/checkout'))!;
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({ plan_key: PLAN.key });
  });

  it('active: usage, renewal, Manage billing; no second subscribe', async () => {
    vi.stubGlobal('fetch', stub([ACTIVE], (url) => (url.endsWith('/v1/esign/billing/portal') ? json({ url: 'https://billing.stripe.test/p' }, 201) : undefined)));
    render(<BillingPanel />);
    expect(await screen.findByText('85 of 100 envelopes used')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.queryByTestId('billing-subscribe')).toBeNull();
    fireEvent.click(screen.getByTestId('billing-manage'));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://billing.stripe.test/p'));
  });

  it('a member without settings authority sees the plan but cannot buy or manage', async () => {
    vi.stubGlobal('fetch', stub([account({ ...ACTIVE, can_manage_billing: false })]));
    render(<BillingPanel />);
    expect(await screen.findByText('Only an organization admin can change the plan.')).toBeInTheDocument();
    expect(screen.queryByTestId('billing-manage')).toBeNull();
    expect(screen.queryByTestId('billing-subscribe')).toBeNull();
  });

  it('past due within grace and past due after grace are explained; signing of sent envelopes continues', async () => {
    const pd = (sending: boolean) =>
      account({ ...ACTIVE, subscription: { ...ACTIVE.subscription!, status: 'PAST_DUE', sending, grace_until: '2026-10-25T00:00:00Z' }, ...(sending ? {} : { allowance: { subscribed: false, allowance_key: 'esign.envelopes', state: 'PAST_DUE' } }) });
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
    fireEvent.click(await screen.findByTestId('billing-subscribe'));
    expect(await screen.findByText(/Online billing isn’t available right now/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});

describe('Journey A — org admin without a Sign role', () => {
  beforeEach(() => configureAuthConsumer('esign'));
  afterEach(() => vi.unstubAllGlobals());

  const session = (scopes: string[]) => ({ sub: 'u1', consumer_type: 'esign', tenant_id: 't1', scopes, iat: 0, exp: 9_999_999_999 });
  const app = (scopes: string[]) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/esign/session')) return json(session(scopes));
      if (url.endsWith('/v1/esign/sender/context')) return json({ error: { code: 'INSUFFICIENT_PERMISSIONS' } }, 403);
      if (url.endsWith('/v1/esign/billing/account')) return json(account());
      if (url.endsWith('/v1/esign/billing/plans')) return json({ plans: [PLAN] });
      return json({ items: [] });
    });

  it('an org admin gets the setup page with the plan', async () => {
    vi.stubGlobal('fetch', app(['tenant:admin:settings', 'tenant:admin:user-manage']));
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('state-setup')).toBeInTheDocument();
    expect(await screen.findByTestId('billing-subscribe')).toBeInTheDocument();
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

