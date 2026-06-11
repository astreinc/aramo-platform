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

// ---------------------------------------------------------------------------
// Search PR-2 — the résumé ?resume_q= wiring into the Talent section.
// ---------------------------------------------------------------------------

// A talent mock distinguishing the name ?q= call from the résumé ?resume_q=
// call. `talentFail` lets a test fail ONE of the two talent calls.
function mockTalentResume(opts: { talentFail?: 'name' | 'resume' } = {}) {
  const json = (items: unknown) =>
    new Response(JSON.stringify({ items }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const fail = () => new Response('{}', { status: 500 });
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes('/v1/talent-records')) {
      const isResume = url.includes('resume_q=');
      if (isResume) {
        if (opts.talentFail === 'resume') return fail();
        // résumé matches: Jane (also a name match → dedupe + snippet upgrade)
        // and Bob (résumé-only → snippet).
        return json([
          { id: 'tal-1', first_name: 'Jane', last_name: 'Doe', email1: null, current_employer: 'Acme', resume_snippet: 'prior <mark>Jane</mark> hit' },
          { id: 'tal-2', first_name: 'Bob', last_name: 'Lee', email1: null, current_employer: null, resume_snippet: 'led the <mark>Kubernetes</mark> migration' },
        ]);
      }
      if (opts.talentFail === 'name') return fail();
      // name matches: Jane (dedupes with résumé) and Carol (name-only).
      return json([
        { id: 'tal-1', first_name: 'Jane', last_name: 'Doe', email1: null, current_employer: 'Acme' },
        { id: 'tal-3', first_name: 'Carol', last_name: 'Ng', email1: null, current_employer: null },
      ]);
    }
    if (url.includes('/v1/companies')) return json([{ id: 'co-1', name: 'Acme Corp' }]);
    if (url.includes('/v1/requisitions')) return json([{ id: 'req-1', title: 'Senior Engineer' }]);
    if (url.includes('/v1/contacts')) return json([{ id: 'ct-1', first_name: 'Sam', last_name: 'Smith', title: 'CTO' }]);
    return new Response('{}', { status: 404 });
  });
}

describe('SearchView — Search PR-2 résumé wiring', () => {
  afterEach(() => vi.restoreAllMocks());

  it('#1 fires TWO talent calls — ?q= AND ?resume_q= (NOT a combined ?q=&resume_q=)', async () => {
    const spy = mockTalentResume();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(['talent:search'])} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByText('Bob Lee')).toBeInTheDocument());
    const paths = entitySearchPaths(spy);
    expect(paths.some((p) => p === '/v1/talent-records?q=a')).toBe(true);
    expect(paths.some((p) => p === '/v1/talent-records?resume_q=a')).toBe(true);
    // The AND-zeroing combined call is NEVER fired.
    expect(paths.some((p) => p.includes('q=a&resume_q=') || p.includes('resume_q=a&q='))).toBe(false);
  });

  it('#2 merge + dedupe — a talent matched by BOTH name and résumé appears once', async () => {
    mockTalentResume();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(['talent:search'])} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByText('Bob Lee')).toBeInTheDocument());
    // Jane is in both the name and résumé results — rendered exactly once.
    expect(screen.getAllByText('Jane Doe')).toHaveLength(1);
  });

  it('#3 snippet — a résumé-match renders its resume_snippet; a name-only match does not', async () => {
    mockTalentResume();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(['talent:search'])} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByText('Bob Lee')).toBeInTheDocument());
    // Bob matched via résumé → snippet rendered, <mark> stripped to text.
    expect(screen.getByText(/Matched in résumé: led the Kubernetes migration/)).toBeInTheDocument();
    // Carol matched by name only → no snippet for her row.
    expect(screen.getByText('Carol Ng')).toBeInTheDocument();
    const snippets = screen.getAllByTestId('resume-snippet').map((n) => n.textContent ?? '');
    expect(snippets.some((t) => t.includes('Carol'))).toBe(false);
  });

  it('#4 scope-gate — no talent:search → no Talent section, NEITHER talent call fired', async () => {
    const spy = mockTalentResume();
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(['company:search'])} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(entitySearchPaths(spy).some((p) => p.includes('/v1/talent-records'))).toBe(false);
    expect(screen.queryByRole('region', { name: 'Talent' })).toBeNull();
  });

  it('#5 allSettled isolation — the name call 500s, the Talent section still renders the résumé results', async () => {
    mockTalentResume({ talentFail: 'name' });
    render(
      <MemoryRouter>
        <SearchView sessionOverride={session(['talent:search'])} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'a' } });
    // The résumé call survived → Bob (résumé-only) renders; the section is NOT in error.
    await waitFor(() => expect(screen.getByText('Bob Lee')).toBeInTheDocument());
    expect(screen.getByText(/Matched in résumé: led the Kubernetes migration/)).toBeInTheDocument();
    expect(screen.queryByText(/talent search could not be completed/i)).toBeNull();
  });
});
