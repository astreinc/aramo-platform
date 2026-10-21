import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { configureAuthConsumer } from '@aramo/fe-foundation';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from './App';

// Domain-Enforcement P3 (LOCKED) §4/§5 — where the Domain card and the delegate
// page live in the Sign application: on the first-time owner's setup page (no
// Sign role yet, so Settings is out of reach), and the public /domain-verification
// route for the IT administrator (no session needed).

vi.mock('./pdf', () => ({ loadPdf: vi.fn() }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const session = (scopes: string[]) => ({ sub: 'u1', consumer_type: 'sign', tenant_id: 't1', scopes, iat: 0, exp: 9_999_999_999 });
const DV = {
  status: 'PENDING',
  allowed_domain: 'acme.example',
  record_name: '_aramo-challenge.acme.example',
  record_value: 'aramo-domain-verification=tok',
  verified_at: null,
  token_issued_at: null,
  domain_claim: 'PROVISIONAL',
  domain_claim_conflict: false,
};
const ACCOUNT = { subscription: null, allowance: { subscribed: false, allowance_key: 'sign.envelopes', state: 'NONE' }, billing_available: true, tenant_kind: 'BUSINESS', self_service_eligible: true, can_manage_billing: true };

function fetchFor(scopes: string[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/auth/sign/session')) return json(session(scopes));
    if (url.endsWith('/v1/sign/sender/context')) return json({ error: { code: 'INSUFFICIENT_PERMISSIONS' } }, 403);
    if (url.endsWith('/v1/sign/billing/account')) return json(ACCOUNT);
    if (url.endsWith('/v1/sign/billing/plans')) return json({ plans: [], terms: null, sales_contact_url: null });
    if (url.endsWith('/v1/tenant/domain-verification')) return json(DV);
    if (url.endsWith('/v1/tenant/domain-verification/delegations')) return json({ items: [] });
    if (url.endsWith('/v1/domain-verification/delegate')) {
      // The delegate call carries the token in the body and no credentials.
      expect(init?.credentials).toBe('omit');
      expect(JSON.parse(String(init?.body))).toEqual({ token: 'tok-abcdefghijklmnop' });
      return json({ domain: 'acme.example', record: { name: DV.record_name, value: DV.record_value }, status: 'PENDING', domain_claim_conflict: false });
    }
    return json({ items: [] });
  });
}

describe('Domain card placement + delegate route', () => {
  beforeEach(() => configureAuthConsumer('sign'));
  afterEach(() => vi.unstubAllGlobals());

  it('the first-time owner sees the Domain card above the plans on the setup page', async () => {
    vi.stubGlobal('fetch', fetchFor(['sign:billing:manage', 'tenant:admin:domain']));
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('state-setup')).toBeInTheDocument();
    expect(await screen.findByTestId('domain-record-value')).toHaveTextContent('aramo-domain-verification=tok');
    const card = screen.getByTestId('domain-card');
    const billing = screen.getByTestId('billing-current');
    expect(card.compareDocumentPosition(billing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without tenant:admin:domain the setup page shows no Domain card', async () => {
    vi.stubGlobal('fetch', fetchFor(['sign:billing:manage']));
    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('state-setup')).toBeInTheDocument();
    expect(screen.queryByTestId('domain-card')).toBeNull();
  });

  it('/domain-verification is the public delegate page (token from the fragment)', async () => {
    vi.stubGlobal('fetch', fetchFor([]));
    window.location.hash = '#token=tok-abcdefghijklmnop';
    render(
      <MemoryRouter initialEntries={['/domain-verification']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('domain-delegate-value')).toHaveTextContent('aramo-domain-verification=tok');
    window.location.hash = '';
  });

  const CTX = {
    user: { id: 'u1', email: 'priya@northwind.test', display_name: 'Priya Nair' },
    tenant: { id: 't1', name: 'Northwind Staffing', kind: 'BUSINESS' },
    workspace: 'sign',
    permissions: { read: true, create: true, send: true },
    can_send: true,
    personal_sending_enabled: false,
    organization_url: null,
    app_home_url: null,
  };
  function settingsFetch(scopes: string[]) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/auth/sign/session')) return json(session(scopes));
      if (url.endsWith('/v1/sign/sender/context')) return json(CTX);
      if (url.endsWith('/v1/tenant/domain-verification')) return json(DV);
      return json({ items: [] });
    });
  }

  it('Settings → Domain (/sign/settings/domain — the key Billing links to) shows the card to an owner / admin', async () => {
    vi.stubGlobal('fetch', settingsFetch(['sign:envelope:read', 'tenant:admin:domain']));
    render(
      <MemoryRouter initialEntries={['/sign/settings/domain']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('domain-card')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Domain' })).toHaveAttribute('href', '/sign/settings/domain');
  });

  it('Settings → Domain is hidden without tenant:admin:domain (redirects to Personal)', async () => {
    vi.stubGlobal('fetch', settingsFetch(['sign:envelope:read']));
    render(
      <MemoryRouter initialEntries={['/sign/settings/domain']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('settings-account')).toBeInTheDocument();
    expect(screen.queryByTestId('domain-card')).toBeNull();
  });
});
