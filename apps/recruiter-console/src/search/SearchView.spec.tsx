import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { SearchView } from './SearchView';

// Search FE /search — proofs for the cross-entity quick-search surface.
// Mirrors the R5-corrected fetch-mock pattern (per-call mockImplementation
// → fresh Response; MemoryRouter; sessionOverride seam; waitFor the
// post-fetch signal). The fetch URL is the bare path (apiClient baseUrl '').

function session(scopes: readonly string[]): Session {
  return {
    sub: 'u1',
    consumer_type: 'recruiter',
    tenant_id: 't',
    scopes: [...scopes],
    iat: 0,
    exp: 0,
  } as Session;
}

const ALL_SEARCH = [
  'talent:search',
  'company:search',
  'requisition:search',
  'contact:search',
];

// Per-endpoint mock. Each entity returns one identifiable row; an endpoint
// in `failing` returns 500 (→ ApiError → that section's run rejects).
function mockFanout(failing: readonly string[] = []) {
  const json = (items: unknown) =>
    new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const fail = () => new Response('{}', { status: 500 });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/talent-records')) {
      return failing.includes('talent')
        ? fail()
        : json([{ id: 'tal-1', first_name: 'Jane', last_name: 'Doe', email1: null, current_employer: 'Acme' }]);
    }
    if (url.includes('/v1/companies')) {
      return failing.includes('companies') ? fail() : json([{ id: 'co-1', name: 'Acme Corp' }]);
    }
    if (url.includes('/v1/requisitions')) {
      return failing.includes('requisitions')
        ? fail()
        : json([{ id: 'req-1', title: 'Senior Engineer', company_id: 'co-1' }]);
    }
    if (url.includes('/v1/contacts')) {
      return failing.includes('contacts')
        ? fail()
        : json([{ id: 'ct-1', company_id: 'co-1', first_name: 'Sam', last_name: 'Smith', title: 'CTO' }]);
    }
    return new Response('{}', { status: 404 });
  });
}

function calledPaths(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

// The entity search calls only (the useSession hook also fetches
// /auth/recruiter/session — not an entity ?q= call).
function entitySearchPaths(spy: ReturnType<typeof vi.spyOn>): string[] {
  return calledPaths(spy).filter((p) => p.includes('/v1/'));
}

describe('SearchView — scope-gating + fan-out', () => {
  afterEach(() => vi.restoreAllMocks());

  it('zero search scopes → "no access", no input, no fetch', () => {
    const spy = mockFanout();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(['talent:read'])} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('search-no-access')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search')).toBeNull();
    expect(entitySearchPaths(spy)).toEqual([]);
  });

  it('empty query → no fan-out (prompt to type)', () => {
    const spy = mockFanout();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL_SEARCH)} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('search-prompt')).toBeInTheDocument();
    expect(entitySearchPaths(spy)).toEqual([]);
  });

  it('all 4 scopes → typing fans out to all 4 ?q= endpoints + renders 4 sections', async () => {
    const spy = mockFanout();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL_SEARCH)} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    const paths = calledPaths(spy);
    expect(paths.some((p) => p.includes('/v1/talent-records?q=a'))).toBe(true);
    expect(paths.some((p) => p.includes('/v1/companies?q=a'))).toBe(true);
    expect(paths.some((p) => p.includes('/v1/requisitions?q=a'))).toBe(true);
    expect(paths.some((p) => p.includes('/v1/contacts?q=a'))).toBe(true);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    expect(screen.getByText('Sam Smith')).toBeInTheDocument();
  });

  it('no talent:search → NO Talent section + NO /v1/talent-records call (R2 asymmetry)', async () => {
    const spy = mockFanout();
    render(
      <MemoryRouter>
        <SearchView
          sessionOverride={session(['company:search', 'requisition:search', 'contact:search'])}
        />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    // The talent ?q= endpoint is NEVER fired (don't fire a 403).
    expect(calledPaths(spy).some((p) => p.includes('/v1/talent-records'))).toBe(false);
    // And no Talent section renders.
    expect(screen.queryByRole('region', { name: 'Talent' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Companies' })).toBeInTheDocument();
  });

  it('allSettled isolation — one endpoint 500s, the others still render', async () => {
    mockFanout(['companies']);
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL_SEARCH)} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    // The other sections render their results...
    await waitFor(() => expect(screen.getByText('Jane Doe')).toBeInTheDocument());
    expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    // ...while the Companies section shows its error, not a crash.
    expect(screen.getByText(/companies search could not be completed/i)).toBeInTheDocument();
  });

  it('R-CONTACTS — contact rows are NON-LINKING; talent rows ARE links', async () => {
    mockFanout();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL_SEARCH)} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByText('Sam Smith')).toBeInTheDocument());
    // Contact: present but NOT a link (no contact detail view exists).
    expect(screen.queryByRole('link', { name: /Sam Smith/ })).toBeNull();
    // Talent: a link to the detail view.
    expect(screen.getByRole('link', { name: 'Jane Doe' })).toHaveAttribute(
      'href',
      '/talent/tal-1',
    );
    expect(screen.getByRole('link', { name: 'Acme Corp' })).toHaveAttribute(
      'href',
      '/companies/co-1',
    );
  });
});
