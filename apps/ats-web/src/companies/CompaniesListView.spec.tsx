import type { ReactElement } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { CompaniesListView } from './CompaniesListView';
import type { CompanyRelationshipView, CompanyView } from './types';

// Company Party/Role (ADR-0032, Slice B) — the list leads with relationship
// TYPE tabs (All / Clients / Vendors / Partners) + a relationship STATUS
// filter, and each company renders "Type · Status" pills from relationships[].
// Row/name click opens the slide-over quick-edit drawer (the read-only preview
// + the left FacetRail are retired).

function renderInRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes, iat: 0, exp: 0 };
}

function rel(type: string, status: string): CompanyRelationshipView {
  return {
    id: `rel-${type}`,
    type,
    status,
    effective_from: '2026-01-01T00:00:00Z',
    effective_to: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
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
    status: 'active',
    relationships: [rel('CLIENT', 'ACTIVE')],
    master_status: 'ACTIVE', communication_restricted: false, description: null,
    industry: null, country: null,
    employee_count_band: null, annual_revenue_band: null, founded_year: null,
    ownership_type: null, registration_number: null, source: null,
    client_tier: null, supplier_status: null, exclusivity: false,
    off_limits: false, tags: [], general_email: null,
    last_activity_at: null, next_action_at: null,
    address_provider_place_id: null, address_provider: null,
    ...overrides,
  };
}

// Server-aware fetch mock — facets over the BASE (scope) set; items narrowed by
// the relationship_type/status selections (some-relationship semantics).
function buildFacets(base: readonly CompanyView[]) {
  const typeTally = new Map<string, number>();
  const statusTally = new Map<string, number>();
  for (const c of base) {
    for (const r of c.relationships) {
      typeTally.set(r.type, (typeTally.get(r.type) ?? 0) + 1);
      statusTally.set(r.status, (statusTally.get(r.status) ?? 0) + 1);
    }
  }
  const toBuckets = (m: Map<string, number>) =>
    [...m.entries()].map(([value, count]) => ({ value, count }));
  return {
    relationship_type: toBuckets(typeTally),
    relationship_status: toBuckets(statusTally),
    tier: [],
    industry: [],
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
    if (
      url.includes('/v1/tenant/users') ||
      url.includes('/v1/reports/') ||
      url.includes('/v1/contacts')
    ) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    const u = new URL(url, 'http://x');
    const scope = u.searchParams.get('scope');
    const base = all.filter((c) => (scope === 'mine' ? c.owner_id === 'u1' : true));
    const typeSel = u.searchParams.get('relationship_type')?.split(',') ?? [];
    const statusSel = u.searchParams.get('relationship_status')?.split(',') ?? [];
    const isHot = u.searchParams.get('is_hot') === 'true';
    const items = base.filter(
      (c) =>
        (typeSel.length === 0 || c.relationships.some((r) => typeSel.includes(r.type))) &&
        (statusSel.length === 0 || c.relationships.some((r) => statusSel.includes(r.status))) &&
        (!isHot || c.is_hot),
    );
    return new Response(
      JSON.stringify({ items, next_cursor: null, facets: buildFacets(base), total: base.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
}

describe('CompaniesListView (server-paged, party/role)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('frames the list as the recruiter\'s VISIBLE companies', async () => {
    installFetch([]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(screen.getByText(/no companies visible to you yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('heading', { name: 'Companies' })).toBeInTheDocument();
  });

  it('renders "Type · Status" relationship pills + industry/location', async () => {
    installFetch([
      makeCompany('co-1', 'Acme Corp', {
        city: 'San Francisco', state: 'CA', industry: 'Robotics',
        client_tier: 'a',
        relationships: [rel('CLIENT', 'ACTIVE'), rel('VENDOR', 'INACTIVE')],
      }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    const table = screen.getByRole('table');
    expect(within(table).getByText(/Robotics/)).toBeInTheDocument();
    expect(within(table).getByText(/San Francisco, CA/)).toBeInTheDocument();
    // both roles shown with their own status
    expect(within(table).getByText('Client · Active')).toBeInTheDocument();
    expect(within(table).getByText('Vendor · Inactive')).toBeInTheDocument();
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

  it('renders the "New company" button only when the session holds company:create', async () => {
    installFetch([]);
    const { unmount } = renderInRouter(
      <CompaniesListView sessionOverride={makeSession(['company:create'])} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/no companies visible to you yet/i)).toBeInTheDocument(),
    );
    expect(screen.getByTestId('company-new')).toBeInTheDocument();
    unmount();
    installFetch([]);
    renderInRouter(<CompaniesListView sessionOverride={makeSession(['company:read'])} />);
    await waitFor(() =>
      expect(screen.getByText(/no companies visible to you yet/i)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('company-new')).toBeNull();
  });

  it('the "New company" button opens the create drawer', async () => {
    installFetch([]);
    renderInRouter(<CompaniesListView sessionOverride={makeSession(['company:create'])} />);
    await waitFor(() =>
      expect(screen.getByText(/no companies visible to you yet/i)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('company-new'));
    await waitFor(() =>
      expect(screen.getByTestId('company-edit-drawer')).toBeInTheDocument(),
    );
  });

  it('a relationship-type TAB refetches and filters server-side', async () => {
    installFetch([
      makeCompany('co-1', 'Client Co', { relationships: [rel('CLIENT', 'ACTIVE')] }),
      makeCompany('co-2', 'Vendor Co', { relationships: [rel('VENDOR', 'ACTIVE')] }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Client Co')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Vendors/i }));
    await waitFor(() => expect(screen.queryByText('Client Co')).toBeNull());
    expect(screen.getByText('Vendor Co')).toBeInTheDocument();
  });

  it('the relationship STATUS filter refetches and filters server-side', async () => {
    installFetch([
      makeCompany('co-1', 'Active Co', { relationships: [rel('CLIENT', 'ACTIVE')] }),
      makeCompany('co-2', 'Prospect Co', { relationships: [rel('CLIENT', 'PROSPECT')] }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Active Co')).toBeInTheDocument());
    // Relationship status is a single-select dropdown (prototype), not pills.
    fireEvent.change(screen.getByLabelText('Relationship status'), {
      target: { value: 'PROSPECT' },
    });
    await waitFor(() => expect(screen.queryByText('Active Co')).toBeNull());
    expect(screen.getByText('Prospect Co')).toBeInTheDocument();
  });

  it('opens the quick-edit drawer from a row', async () => {
    installFetch([makeCompany('co-1', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    // Row click (off the name link) opens the drawer — no separate action button.
    const row = screen.getByText('Acme Corp').closest('tr');
    fireEvent.click(row as HTMLElement);
    await waitFor(() =>
      expect(screen.getByTestId('company-edit-drawer')).toBeInTheDocument(),
    );
    // edit mode → "Open full record" points at the hub
    expect(screen.getByTestId('company-open-full-record')).toHaveAttribute(
      'href', '/companies/co-1',
    );
  });

  it('renders (no blank/crash) when the API returns the legacy {items}-only shape', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url;
      if (url.includes('/v1/tenant/users') || url.includes('/v1/reports/')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      // legacy list — ONLY { items } (no facets/total/next_cursor)
      return new Response(
        JSON.stringify({ items: [makeCompany('co-1', 'Legacy Co')] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('Legacy Co')).toBeInTheDocument());
    // tabs still render (badge counts simply absent), no crash
    expect(screen.getByRole('button', { name: /all companies/i })).toBeInTheDocument();
  });

  it('shows the visible-company count in the filter row', async () => {
    installFetch([
      makeCompany('co-1', 'A Co'),
      makeCompany('co-2', 'B Co'),
      makeCompany('co-3', 'C Co'),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() => expect(screen.getByText('A Co')).toBeInTheDocument());
    expect(screen.getByText(/3 companies · click a row/i)).toBeInTheDocument();
  });
});
