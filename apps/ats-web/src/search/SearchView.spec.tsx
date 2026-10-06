import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { SearchView } from './SearchView';
import type { SearchResults } from './enterprise-search-api';

// Enterprise Search GS-1 — SearchView proofs against the UNIFIED /v1/search contract. The view
// now issues ONE call and renders the grouped, authority-safe response (no per-entity fan-out).
// Highlight fragments matched substrings into <mark> nodes, so assertions use role-name queries
// (accessible name concatenates the fragments).

function session(scopes: readonly string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't', scopes: [...scopes], iat: 0, exp: 0 } as Session;
}
const ALL = ['talent:search', 'company:search', 'requisition:search', 'contact:search'];

const RESULTS: SearchResults = {
  query: 'eng',
  groups: [
    {
      entity_type: 'TALENT',
      hits: [
        {
          entity_type: 'TALENT',
          entity_id: 'tal-1',
          display_label: 'Jane Doe',
          subtitle: 'Engineer',
          snippet: 'led the <mark>Kubernetes</mark> migration',
          route: '/talent/tal-1',
          match: { signal: 'lexical', relevance: 0.5 },
        },
      ],
    },
    {
      entity_type: 'REQUISITION',
      hits: [
        { entity_type: 'REQUISITION', entity_id: 'req-1', display_label: 'Senior Role', subtitle: 'REQ-1042', snippet: null, route: '/requisitions/req-1', match: { signal: 'exact', relevance: 1 } },
      ],
    },
    {
      entity_type: 'COMPANY',
      hits: [
        { entity_type: 'COMPANY', entity_id: 'co-1', display_label: 'Acme Corp', subtitle: null, snippet: null, route: '/companies/co-1', match: { signal: 'lexical', relevance: 0.7 } },
      ],
    },
    {
      entity_type: 'CONTACT',
      hits: [
        { entity_type: 'CONTACT', entity_id: 'ct-1', display_label: 'Sam Smith', subtitle: 'CTO', snippet: null, route: '/companies/co-1', match: { signal: 'lexical', relevance: 0.7 } },
      ],
    },
  ],
};

function mockSearch(handler: (url: string) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/search')) return handler(url);
    return new Response('{}', { status: 404 });
  });
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function searchCalls(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/v1/search'));
}

describe('SearchView — unified /v1/search', () => {
  afterEach(() => vi.restoreAllMocks());

  it('zero search scopes → "no access", no input, no /v1/search call', () => {
    const spy = mockSearch(() => ok(RESULTS));
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(['talent:read'])} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('search-no-access')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search')).toBeNull();
    expect(searchCalls(spy)).toEqual([]);
  });

  it('empty query → prompt, no call', () => {
    const spy = mockSearch(() => ok(RESULTS));
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL)} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('search-prompt')).toBeInTheDocument();
    expect(searchCalls(spy)).toEqual([]);
  });

  it('typing issues ONE /v1/search call and renders grouped sections', async () => {
    const spy = mockSearch(() => ok(RESULTS));
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL)} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'eng' } });
    await waitFor(() => expect(screen.getByRole('link', { name: 'Jane Doe' })).toBeInTheDocument());
    const calls = searchCalls(spy);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/v1/search?q=eng');
    // Grouped sections present.
    for (const label of ['Talent', 'Requisitions', 'Companies', 'Contacts']) {
      expect(screen.getByRole('region', { name: label })).toBeInTheDocument();
    }
    // Server-provided routes; contacts now link (to their company).
    expect(screen.getByRole('link', { name: 'Jane Doe' })).toHaveAttribute('href', '/talent/tal-1');
    expect(screen.getByRole('link', { name: 'Acme Corp' })).toHaveAttribute('href', '/companies/co-1');
    expect(screen.getByRole('link', { name: 'Sam Smith' })).toHaveAttribute('href', '/companies/co-1');
  });

  it('renders a resume snippet safely (mark markers → text)', async () => {
    mockSearch(() => ok(RESULTS));
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL)} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'eng' } });
    await waitFor(() => expect(screen.getByTestId('resume-snippet')).toBeInTheDocument());
    expect(screen.getByTestId('resume-snippet').textContent).toContain('Kubernetes');
  });

  it('empty result set → honest empty state', async () => {
    mockSearch(() => ok({ query: 'zzz', groups: [] }));
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL)} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'zzz' } });
    await waitFor(() => expect(screen.getByTestId('search-empty')).toBeInTheDocument());
  });

  it('server error → error alert (not a crash, not silent empty)', async () => {
    mockSearch(() => new Response('{}', { status: 500 }));
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(ALL)} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'eng' } });
    await waitFor(() => expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument());
  });
});
