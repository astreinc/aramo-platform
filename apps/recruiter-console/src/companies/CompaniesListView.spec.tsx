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
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function makeCompany(
  id: string,
  name: string,
  overrides: Partial<CompanyView> = {},
): CompanyView {
  return {
    id, tenant_id: 't', site_id: null, name,
    address: null, address2: null, city: null, state: null, zip: null,
    phone1: null, phone2: null, fax_number: null, url: null,
    key_technologies: null, notes: null, is_hot: false,
    billing_contact_id: null, owner_id: null, entered_by_id: null,
    created_at: '2026-06-01T00:00:00Z', updated_at: '2026-06-01T00:00:00Z',
    status: 'active', description: null, industry: null, country: null,
    employee_count_band: null, annual_revenue_band: null, founded_year: null,
    ownership_type: null, registration_number: null, source: null,
    client_tier: null, supplier_status: null, exclusivity: false,
    off_limits: false, tags: [], general_email: null,
    last_activity_at: null, next_action_at: null,
    address_provider_place_id: null, address_provider: null,
    ...overrides,
  };
}

// Server-aware fetch mock: parses the ?paged query and replicates the server's
// base/selection split — facets + total over the BASE (scope) set; items over
// the BASE + facet/segment selections. The roster probe (/v1/tenant/users)
// returns an empty available roster.
function buildFacets(base: readonly CompanyView[]) {
  const tally = (key: keyof CompanyView) => {
    const m = new Map<string, number>();
    for (const c of base) {
      const v = c[key];
      if (v === null || v === undefined || v === '') continue;
      m.set(String(v), (m.get(String(v)) ?? 0) + 1);
    }
    return [...m.entries()].map(([value, count]) => ({ value, count }));
  };
  return {
    relationship: tally('status'),
    tier: tally('client_tier'),
    industry: tally('industry'),
    hot: base.filter((c) => c.is_hot).length,
    off_limits: base.filter((c) => c.off_limits).length,
    exclusivity: base.filter((c) => c.exclusivity).length,
    quiet: base.filter((c) => c.last_activity_at === null).length,
  };
}

function installFetch(all: readonly CompanyView[], status = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    if (status !== 200) {
      return new Response(JSON.stringify({ message: 'forbidden' }), {
        status, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/v1/tenant/users')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/v1/reports/company-metrics')) {
      // Phase 3 — metrics are best-effort; an empty set leaves the Open reqs /
      // Active columns at "—" (the list assertions don't depend on the numbers).
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    const u = new URL(url, 'http://x');
    const scope = u.searchParams.get('scope');
    const base = all.filter((c) => (scope === 'mine' ? c.owner_id === 'u1' : true));
    const statusSel = u.searchParams.get('status')?.split(',') ?? [];
    const tierSel = u.searchParams.get('client_tier')?.split(',') ?? [];
    const isHot = u.searchParams.get('is_hot') === 'true';
    const quiet = u.searchParams.get('quiet') === 'true';
    const offLimits = u.searchParams.get('off_limits') === 'true';
    const items = base.filter(
      (c) =>
        (statusSel.length === 0 || statusSel.includes(c.status)) &&
        (tierSel.length === 0 || (c.client_tier !== null && tierSel.includes(c.client_tier))) &&
        (!isHot || c.is_hot) &&
        (!quiet || c.last_activity_at === null) &&
        (!offLimits || c.off_limits),
    );
    return new Response(
      JSON.stringify({ items, next_cursor: null, facets: buildFacets(base), total: base.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

describe('CompaniesListView (server-paged)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('frames the list as the recruiter\'s VISIBLE clients', async () => {
    installFetch([]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(screen.getByText(/no companies visible to you yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Companies' })).toBeInTheDocument();
    expect(screen.getByText(/your visible clients/i)).toBeInTheDocument();
  });

  it('renders relationship / tier / industry from real fields', async () => {
    installFetch([
      makeCompany('co-1', 'Acme Corp', {
        city: 'San Francisco', state: 'CA', industry: 'Robotics',
        client_tier: 'a', is_hot: true,
      }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    const table = screen.getByRole('table');
    // industry · tier · location now render as one company-cell subtitle node.
    expect(within(table).getByText(/Robotics/)).toBeInTheDocument();
    expect(within(table).getByText(/Key account/)).toBeInTheDocument();
    expect(within(table).getByText(/San Francisco, CA/)).toBeInTheDocument();
    expect(within(table).getByText('Client')).toBeInTheDocument();
  });

  it('surfaces a permission message when the BE returns 403', async () => {
    installFetch([], 403);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(
        screen.getByText(/do not have permission to view companies/i),
      ).toBeInTheDocument(),
    );
  });

  it('the name cell links to the company detail at /companies/:id', async () => {
    installFetch([makeCompany('co-42', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /Acme Corp/i })).toHaveAttribute(
      'href', '/companies/co-42',
    );
  });

  it('renders "New company" only when the session holds company:create', async () => {
    installFetch([]);
    const { unmount } = renderInRouter(
      <CompaniesListView sessionOverride={makeSession(['company:create'])} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/no companies visible to you yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /new company/i })).toHaveAttribute(
      'href', '/companies/new',
    );
    unmount();
    installFetch([]);
    renderInRouter(<CompaniesListView sessionOverride={makeSession(['company:read'])} />);
    await waitFor(() =>
      expect(screen.getByText(/no companies visible to you yet/i)).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /new company/i })).toBeNull();
  });

  it('the Hot clients segment refetches and filters server-side', async () => {
    installFetch([
      makeCompany('co-1', 'Hot Co', { is_hot: true }),
      makeCompany('co-2', 'Cool Co', { is_hot: false }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Hot Co')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /hot clients/i }));
    await waitFor(() => expect(screen.queryByText('Cool Co')).toBeNull());
    expect(screen.getByText('Hot Co')).toBeInTheDocument();
  });

  it('the relationship facet refetches and filters server-side', async () => {
    installFetch([
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
    installFetch([makeCompany('co-1', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.getByRole('table')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cards' }));
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
  });

  it('opens the preview drawer from a row', async () => {
    installFetch([makeCompany('co-1', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /preview Acme Corp/i }));
    await waitFor(() =>
      expect(
        screen.getByRole('dialog', { name: /Acme Corp — preview/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('link', { name: /open account/i })).toHaveAttribute(
      'href', '/companies/co-1',
    );
  });

  it('renders (no blank/crash) when the API returns the legacy {items}-only shape', async () => {
    // Regression: a non-paged response has no facets/total/next_cursor. The
    // segment badges must NOT throw on undefined facets (was a blank page).
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/v1/tenant/users') || url.includes('/v1/reports/')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      // legacy companies list — ONLY { items } (no facets/total/next_cursor)
      return new Response(
        JSON.stringify({ items: [makeCompany('co-1', 'Legacy Co')] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Legacy Co')).toBeInTheDocument());
    // segments still render (badge counts simply absent), no crash
    expect(screen.getByRole('button', { name: /all accounts/i })).toBeInTheDocument();
  });

  it('shows the "N of M" count from the server total', async () => {
    installFetch([
      makeCompany('co-1', 'A Co'),
      makeCompany('co-2', 'B Co'),
      makeCompany('co-3', 'C Co'),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('A Co')).toBeInTheDocument());
    expect(screen.getByText(/of 3 companies/i)).toBeInTheDocument();
  });
});
