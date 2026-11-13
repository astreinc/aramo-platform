import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../App';
import { platformSession } from '../../skills/test-session';
import { ROLE_SCOPES } from '../catalog/catalog-test-data';
import { billingRegionEffectRows, summaryOf } from '../commercial-model';
import type { ChangeRequest } from '../commercial-api';
import { billingPayload, channelWhere, defaultProductId, initialBillingRows } from '../catalog/billing-products-model';
import { REGIONAL_PRICES_TITLE } from '../catalog/RegionalPricesEditor';

import type { BillingRegion } from './billing-regions-api';
import { changeOf, enableBlockers, formErrors, formOf } from './billing-regions-model';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10, §5, §6 G-3, ruling Q3 — Commercial › Billing
// regions through the REAL console route gate (App → commercialGate(platform:catalog:read)), fetch answered
// here; plus the pure page model, the approval drawer rows of a BILLING_REGION_CHANGE and the Razorpay
// billing-product copy.

type Call = { method: string; url: string; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const US: BillingRegion = {
  country: 'US',
  gateway: 'STRIPE',
  currency: 'USD',
  enabled: true,
  personal_web_enabled: true,
  business_web_enabled: true,
  price_tax_mode: 'UNSET',
  selling_entity: { id: 'e-us', key: 'aramo-us', display_name: 'Aramo', legal_name: 'Aramo', country: 'US', active: true },
  gateway_configured: true,
  enable_refusal: null,
  registration: {},
  open_requests: [],
};
const IN: BillingRegion = {
  country: 'IN',
  gateway: 'RAZORPAY',
  currency: 'INR',
  enabled: false,
  personal_web_enabled: false,
  business_web_enabled: false,
  price_tax_mode: 'UNSET',
  selling_entity: { id: 'e-in', key: 'aramo-in', display_name: 'Aramo India', legal_name: 'Aramo India', country: 'IN', active: false },
  gateway_configured: false,
  enable_refusal: 'gateway_not_configured',
  registration: {},
  open_requests: [],
};

describe('India Billing §4.10 Billing regions page', () => {
  let calls: Call[];
  const realLocation = window.location;

  function mockApi(role: string) {
    calls = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, url, body });
      if (url.includes('/auth/platform/session')) return json(platformSession([...(ROLE_SCOPES[role] ?? [])]));
      if (url.includes('/platform/me')) return json({ user_id: 'u1', email: 'lena.fischer@aramo.ai', display_name: 'Lena Fischer', tenant_id: 't', tenant_name: 'Aramo Platform', role_keys: [role] });
      if (url.endsWith('/platform/commercial/billing-regions') && method === 'GET') return json({ regions: [IN, US] });
      if (url.endsWith('/platform/commercial/change-requests') && method === 'POST') {
        return json({ request: { id: '019a0000-0000-7000-8000-00000000c001', action_type: 'BILLING_REGION_CHANGE', state: 'DRAFT' }, replayed: false }, 201);
      }
      if (url.endsWith('/submit') && method === 'POST') return json({ request: { id: '019a0000-0000-7000-8000-00000000c001', action_type: 'BILLING_REGION_CHANGE', state: 'PENDING_APPROVAL' } });
      return json({}, 404);
    });
  }

  function renderAt(path: string) {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    configureAuthConsumer('platform');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...realLocation, assign: vi.fn(), pathname: '/commercial/billing-regions', search: '', hash: '', origin: 'http://localhost' },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: realLocation });
    configureAuthConsumer('recruiter');
  });

  it('IB-W-1 a catalog reader sees every region: gateway, currency, entity, switches, GST mode and gateway keys; no change form is enabled', async () => {
    mockApi('finance_admin');
    renderAt('/commercial/billing-regions');
    expect(await screen.findByRole('heading', { level: 1, name: 'Billing regions' })).toBeInTheDocument();
    const india = await screen.findByTestId('region-IN');
    expect(within(india).getByText('Razorpay')).toBeInTheDocument();
    expect(within(india).getByText('INR')).toBeInTheDocument();
    expect(within(india).getByText('Aramo India')).toBeInTheDocument();
    expect(within(india).getByText('Not set yet')).toBeInTheDocument();
    expect(screen.getByTestId('gateway-configured-IN')).toHaveTextContent('Not configured');
    expect(screen.getByTestId('gateway-configured-US')).toHaveTextContent('Configured');
    expect(screen.getByRole('note')).toHaveTextContent('View only');
    fireEvent.click(screen.getByRole('button', { name: 'Open India (IN)' }));
    const detail = await screen.findByTestId('region-detail');
    expect(within(detail).getByText('Add the gateway keys on the server first.')).toBeInTheDocument();
    expect(within(detail).getByRole('checkbox', { name: 'Region selling (master switch)' })).toBeDisabled();
    expect(within(detail).queryByRole('button', { name: 'Request change' })).toBeNull();
  });

  it('IB-W-2 a catalog manager requests a change: only the changed fields, created then submitted; G-3 reasons in plain words', async () => {
    mockApi('catalog_manager');
    renderAt('/commercial/billing-regions');
    fireEvent.click(await screen.findByRole('button', { name: 'Open India (IN)' }));
    const detail = await screen.findByTestId('region-detail');
    const request = within(detail).getByRole('button', { name: 'Request change' });
    expect(request).toBeDisabled();
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Region selling (master switch)' }));
    const blockers = within(detail).getByTestId('region-blockers');
    expect(blockers).toHaveTextContent('Add the gateway keys on the server first.');
    expect(blockers).toHaveTextContent('Activate the selling entity.');
    expect(blockers).toHaveTextContent('Set how prices handle GST.');
    fireEvent.change(within(detail).getByRole('combobox', { name: 'How prices handle GST' }), { target: { value: 'INCLUSIVE' } });
    fireEvent.click(within(detail).getByRole('checkbox', { name: 'Selling entity active' }));
    expect(within(detail).getByTestId('region-blockers')).not.toHaveTextContent('Set how prices handle GST.');
    fireEvent.change(within(detail).getByRole('textbox', { name: 'GSTIN' }), { target: { value: 'bad' } });
    expect(within(detail).getByRole('alert')).toHaveTextContent('GSTIN must be the 15-character GST number');
    fireEvent.change(within(detail).getByRole('textbox', { name: 'GSTIN' }), { target: { value: '27AAPFU0939F1ZV' } });
    fireEvent.change(within(detail).getByRole('textbox', { name: 'Reason for the change' }), { target: { value: 'India launch setup' } });
    expect(request).toBeEnabled();
    fireEvent.click(request);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/submit'))).toBe(true));
    const create = calls.find((c) => c.method === 'POST' && c.url.endsWith('/platform/commercial/change-requests'));
    expect(create?.body).toMatchObject({
      action_type: 'BILLING_REGION_CHANGE',
      reason: 'India launch setup',
      payload: { country: 'IN', enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { active: true, registration: { gstin: '27AAPFU0939F1ZV' } } },
    });
    expect((create?.body as { payload: Record<string, unknown> }).payload).not.toHaveProperty('personal_web_enabled');
    expect(await screen.findByRole('status')).toHaveTextContent('Change to India (IN) requested');
  });

  it('IB-W-3 the nav lists Billing regions under Commercial for a catalog reader', async () => {
    mockApi('read_only_auditor');
    renderAt('/commercial/billing-regions');
    expect(await screen.findByRole('link', { name: /Billing regions/ })).toHaveAttribute('href', '/commercial/billing-regions');
  });
});

describe('India Billing §4.10 page model (pure)', () => {
  it('IB-M-1 changeOf: nothing changed → null; registration replaced as a whole and trimmed; empty fields dropped', () => {
    expect(changeOf(IN, formOf(IN))).toBeNull();
    const f = formOf(IN);
    f.registration = { ...f.registration, gstin: ' 27AAPFU0939F1ZV ', note: '' };
    f.personal_web_enabled = true;
    expect(changeOf(IN, f)).toEqual({ country: 'IN', personal_web_enabled: true, selling_entity: { registration: { gstin: '27AAPFU0939F1ZV' } } });
  });
  it('IB-M-2 formErrors and enableBlockers (a Stripe region never needs the GST setting)', () => {
    const f = { ...formOf(IN), display_name: ' ', registration: { pan: 'X' } };
    expect(formErrors(f)).toHaveLength(2);
    expect(enableBlockers(IN, formOf(IN))).toEqual([]);
    expect(enableBlockers(US, { ...formOf(US), enabled: true })).toEqual([]);
  });
});

describe('India Billing approvals and catalog copy', () => {
  it('IB-A-1 a BILLING_REGION_CHANGE reads in the inbox and drawer: summary and one row per changed field', () => {
    const payload = { country: 'IN', enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { active: true, registration: { gstin: '27AAPFU0939F1ZV' } } };
    expect(summaryOf({ action_type: 'BILLING_REGION_CHANGE', payload } as unknown as ChangeRequest, { id: 'u1', name: null } as never)).toBe('Change billing region India (IN)');
    expect(billingRegionEffectRows(payload).map((r) => [r.field, r.after])).toEqual([
      ['Region', 'India (IN)'],
      ['Region selling (master switch)', 'On'],
      ['GST in prices', 'Prices include GST'],
      ['Selling entity', 'Active'],
      ['Registration · GSTIN', '27AAPFU0939F1ZV'],
    ]);
  });
  it('IB-A-2 Razorpay is offered on Personal and Business with its web copy; it needs no store listing', () => {
    expect(channelWhere('STRIPE')).toBe('Web (Stripe): United States');
    expect(channelWhere('RAZORPAY')).toBe('Web India (Razorpay): India');
    expect(defaultProductId('RAZORPAY', 'aramo-sign-standard-business-v1')).toBe('aramo_sign_business_standard');
    const rows = initialBillingRows({ billing_eligible: ['STRIPE', 'RAZORPAY'], billing_carry_forward: [], billing_products: [] }, 'aramo-sign-standard-business-v1');
    // Razorpay starts unticked on a plan that does not sell on it yet (India ships off); ticked, it needs no listing.
    expect(rows.map((r) => [r.provider, r.selected])).toEqual([['STRIPE', true], ['RAZORPAY', false]]);
    expect(initialBillingRows({ billing_eligible: ['RAZORPAY'], billing_carry_forward: [{ provider: 'RAZORPAY', interval: 'MONTH', product_id: 'aramo_sign_business_standard' }], billing_products: [] }, 'aramo-sign-standard-business-v1')[0]?.selected).toBe(true);
    rows[1] = { ...rows[1]!, selected: true };
    expect(billingPayload(rows, null, { name: 'Business', description: 'x' })).toEqual({
      products: [
        { provider: 'STRIPE', interval: 'MONTH', product_id: 'aramo_sign_business_standard' },
        { provider: 'RAZORPAY', interval: 'MONTH', product_id: 'aramo_sign_business_standard' },
      ],
    });
    expect(REGIONAL_PRICES_TITLE).toBe('Regional prices (stores and web)');
  });
});
