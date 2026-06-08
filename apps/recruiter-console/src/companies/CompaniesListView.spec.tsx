import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
    ...overrides,
  };
}

// R6' — view now does a session probe via useSession() alongside the
// LIST fetch. `mockResolvedValue(new Response(...))` returns the SAME
// Response (body read-once); the second fetch consumes an already-read
// body and the items vanish. mockImplementation yields a fresh Response
// per call (R4 lesson, applied here).
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
    // Wait for the empty-state (post-fetch), not the header (always
    // present pre-fetch). Asserting the post-fetch text first removes
    // a CI flake where the test could outrun the fetch resolution.
    await waitFor(() =>
      expect(
        screen.getByText(/no companies visible to you yet/i),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Companies')).toBeInTheDocument();
    // Header carries the visibility framing.
    expect(screen.getByText(/your visible clients/i)).toBeInTheDocument();
    // No inline limitation note — a visible-only LIST is correct behavior.
    expect(
      screen.queryByText(/some companies may not be shown/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/limited view/i),
    ).not.toBeInTheDocument();
  });

  it('renders the columns from the company fields', async () => {
    mockFetch([
      makeCompany('co-1', 'Acme Corp', {
        city: 'San Francisco',
        state: 'CA',
        phone1: '555-0200',
        key_technologies: 'TypeScript, Postgres, Kubernetes',
        is_hot: true,
      }),
    ]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    expect(screen.getByText('San Francisco, CA')).toBeInTheDocument();
    expect(screen.getByText('555-0200')).toBeInTheDocument();
    expect(
      screen.getByText(/TypeScript, Postgres, Kubernetes/),
    ).toBeInTheDocument();
    expect(screen.getByText('Yes')).toBeInTheDocument();
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
      expect(
        screen.getByTestId('companies-cap-banner'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/showing first 50 companies/i),
    ).toBeInTheDocument();
  });

  it('does NOT show the cap banner when the list is under the cap', async () => {
    mockFetch([makeCompany('co-1', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('companies-cap-banner'),
    ).not.toBeInTheDocument();
  });

  // R3 — the primary-name cell links to /companies/:id (ruling 5: column-
  // content change, Table frozen). This replaces R2's "non-navigating
  // rows" assertion now that the detail view exists.
  it('the name cell links to the company detail at /companies/:id', async () => {
    mockFetch([makeCompany('co-42', 'Acme Corp')]);
    renderInRouter(<CompaniesListView />);
    await waitFor(() =>
      expect(screen.getByText('Acme Corp')).toBeInTheDocument(),
    );
    const link = screen.getByRole('link', { name: 'Acme Corp' });
    expect(link).toHaveAttribute('href', '/companies/co-42');
  });

  // R6' — the LIST CTA (scope-gated).
  it('renders "+ New company" when the session holds company:create', async () => {
    mockFetch([]);
    renderInRouter(
      <CompaniesListView sessionOverride={makeSession(['company:create'])} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no companies visible to you yet/i),
      ).toBeInTheDocument(),
    );
    const link = screen.getByRole('link', { name: /\+ new company/i });
    expect(link).toHaveAttribute('href', '/companies/new');
  });

  it('hides "+ New company" when company:create is absent', async () => {
    mockFetch([]);
    renderInRouter(
      <CompaniesListView sessionOverride={makeSession(['company:read'])} />,
    );
    await waitFor(() =>
      expect(
        screen.getByText(/no companies visible to you yet/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByRole('link', { name: /\+ new company/i })).toBeNull();
  });
});
