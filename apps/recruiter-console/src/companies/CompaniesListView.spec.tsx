import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { CompaniesListView } from './CompaniesListView';
import type { CompanyView } from './types';

function renderInRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeSession(scopes: string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes,
    iat: 0,
    exp: 0,
  };
}

function makeCompany(
  id: string,
  name: string,
  overrides: Partial<CompanyView> = {},
): CompanyView {
  return {
    id,
    tenant_id: 't',
    site_id: null,
    name,
    address: null,
    address2: null,
    city: null,
    state: null,
    zip: null,
    phone1: null,
    phone2: null,
    fax_number: null,
    url: null,
    key_technologies: null,
    notes: null,
    is_hot: false,
    billing_contact_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    status: 'active',
    description: null,
    industry: null,
    country: null,
    employee_count_band: null,
    annual_revenue_band: null,
    founded_year: null,
    ownership_type: null,
    registration_number: null,
    source: null,
    client_tier: null,
    supplier_status: null,
    exclusivity: false,
    tags: [],
    general_email: null,
    last_activity_at: null,
    next_action_at: null,
    address_provider_place_id: null,
    address_provider: null,
    ...overrides,
  };
}

// The view fires two GETs: the list (/v1/companies) and a roster probe
// (/v1/tenant/users, via probeTenantUsers). mockImplementation yields a fresh
// Response per call (a single mockResolvedValue would be read-once). The roster
// probe receives {items} too — companies have no is_active, so it filters to an
// empty roster, which is fine (owner column shows —).
function mockFetch(items: readonly CompanyView[], status = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ items }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

function mockFetchError(status: number) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify({ message: 'forbidden' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('CompaniesListView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('frames the list as the recruiter\'s VISIBLE clients (D4b scoping)', async () => {
    mockFetch([]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(
        screen.getByText(/no companies visible to you yet/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Companies' })).toBeInTheDocument();
    expect(screen.getByText(/your visible clients/i)).toBeInTheDocument();
    expect(
      screen.queryByText(/some companies may not be shown/i),
    ).not.toBeInTheDocument();
  });

  it('renders relationship / tier / industry / last-contact from real fields', async () => {
    mockFetch([
      makeCompany('co-1', 'Acme Corp', {
        city: 'San Francisco',
        state: 'CA',
        industry: 'Robotics',
        client_tier: 'a',
        is_hot: true,
        last_activity_at: '2026-06-01T00:00:00Z',
      }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    const table = screen.getByRole('table');
    expect(within(table).getByText('San Francisco, CA')).toBeInTheDocument();
    expect(within(table).getByText('Robotics')).toBeInTheDocument();
    // status active → "Client" pill; client_tier a → "Key account" tag.
    // (Both labels also appear as facet-rail options, so scope to the table.)
    expect(within(table).getByText('Client')).toBeInTheDocument();
    expect(within(table).getByText('Key account')).toBeInTheDocument();
  });

  it('surfaces a permission message when the BE returns 403', async () => {
    mockFetchError(403);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to view companies/i),
      ).toBeInTheDocument(),
    );
  });

  it('discloses the truncation when the BE default cap is hit', async () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      makeCompany(`co-${i}`, `Company ${i}`),
    );
    mockFetch(items);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(screen.getByTestId('companies-cap-banner')).toBeInTheDocument(),
    );
    expect(screen.getByText(/showing the first 50 companies/i)).toBeInTheDocument();
  });

  it('does NOT show the cap banner when the list is under the cap', async () => {
    mockFetch([makeCompany('co-1', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.queryByTestId('companies-cap-banner')).not.toBeInTheDocument();
  });

  it('the name cell links to the company detail at /companies/:id', async () => {
    mockFetch([makeCompany('co-42', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Acme Corp/i })).toHaveAttribute(
      'href',
      '/companies/co-42',
    );
  });

  it('renders "New company" only when the session holds company:create', async () => {
    mockFetch([]);
    const { unmount } = renderInRouter(
      <CompaniesListView sessionOverride={makeSession(['company:create'])} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no companies visible to you yet/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /new company/i })).toHaveAttribute(
      'href',
      '/companies/new',
    );
    unmount();
    mockFetch([]);
    renderInRouter(
      <CompaniesListView sessionOverride={makeSession(['company:read'])} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no companies visible to you yet/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /new company/i })).toBeNull();
  });

  it('segments filter client-side (Hot clients shows only hot accounts)', async () => {
    mockFetch([
      makeCompany('co-1', 'Hot Co', { is_hot: true }),
      makeCompany('co-2', 'Cool Co', { is_hot: false }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Hot Co')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /hot clients/i }));
    await waitFor(() => expect(screen.queryByText('Cool Co')).toBeNull());
    expect(screen.getByText('Hot Co')).toBeInTheDocument();
  });

  it('the relationship facet filters the table', async () => {
    mockFetch([
      makeCompany('co-1', 'Client Co', { status: 'active' }),
      makeCompany('co-2', 'Prospect Co', { status: 'prospect' }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Client Co')).toBeInTheDocument());
    const facets = screen.getByRole('complementary', { name: 'Filters' });
    fireEvent.click(within(facets).getByText('Prospect'));
    await waitFor(() => expect(screen.queryByText('Client Co')).toBeNull());
    expect(screen.getByText('Prospect Co')).toBeInTheDocument();
  });

  it('toggles between Table and Cards views', async () => {
    mockFetch([makeCompany('co-1', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.getByRole('table')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('opens the preview drawer from a row', async () => {
    mockFetch([makeCompany('co-1', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /preview Acme Corp/i }));
    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: /Acme Corp — preview/i }),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('link', { name: /open account/i }),
    ).toHaveAttribute('href', '/companies/co-1');
  });
});
