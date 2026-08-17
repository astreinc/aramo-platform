import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@aramo/fe-foundation';

import { MarginView } from './MarginView';
import type { MarginReport } from './margin-types';

// T9-B4 — the dedicated margin view. Fetches on mount ONLY when the actor holds
// assignment:commercials:read (no fetch when gated away, §26); renders the
// (currency, rate_period) groups with the governed group_margin_percent (null → "—"),
// the forward-materialized coverage wording, and the zero-state. No pay/bill/spread/
// person-level values ever render.

afterEach(() => vi.restoreAllMocks());

function makeSession(scopes: string[]): Session {
  return { sub: 'u1', consumer_type: 'recruiter', tenant_id: 't1', scopes, iat: 0, exp: 0 };
}
const WITH_COMMERCIAL = makeSession(['report:read', 'assignment:commercials:read']);
const WITHOUT_COMMERCIAL = makeSession(['report:read']);

const REPORT: MarginReport = {
  eligible_count: 3,
  commercialized_count: 2,
  missing_commercial_count: 1,
  coverage: 'forward_materialized',
  groups: [
    { currency: 'USD', rate_period: 'HOURLY', assignment_count: 2, group_margin_percent: '25.00' },
    { currency: 'USD', rate_period: 'ANNUAL', assignment_count: 1, group_margin_percent: null },
  ],
};

// A FRESH Response per call — the component fetches twice (useSession's session
// bootstrap + getMargin), and a Response body is single-use.
function mockFetch(report: MarginReport): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(report), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

describe('MarginView', () => {
  it('renders the groups, coverage counts, and forward-materialized wording', async () => {
    mockFetch(REPORT);
    render(<MarginView sessionOverride={WITH_COMMERCIAL} />);
    await waitFor(() => expect(screen.getByTestId('margin-content')).toBeInTheDocument());

    expect(screen.getByTestId('margin-eligible')).toHaveTextContent('3');
    expect(screen.getByTestId('margin-commercialized')).toHaveTextContent('2');
    expect(screen.getByTestId('margin-missing')).toHaveTextContent('1');
    // deterministic group order (currency ASC, then HOURLY before ANNUAL)
    // T10-B4/F-031 — the percent is displayed with a % unit (server value, no
    // frontend recomputation).
    expect(screen.getByTestId('margin-pct-USD-HOURLY')).toHaveTextContent('25.00%');
    // null margin renders safely as an em dash
    expect(screen.getByTestId('margin-pct-USD-ANNUAL')).toHaveTextContent('—');
    // T10-B5/F-038 — column-header semantics; F-039 — responsive containment.
    const table = screen.getByTestId('margin-groups');
    const headers = within(table).getAllByRole('columnheader');
    expect(headers).toHaveLength(4);
    headers.forEach((h) => expect(h).toHaveAttribute('scope', 'col'));
    expect(table.closest('.rc-tablewrap')).not.toBeNull();
    // coverage wording is visible and truthful
    expect(screen.getByTestId('margin-coverage-note')).toHaveTextContent(
      'Current assignment rate margin — forward-materialized coverage only.',
    );
    // no per-row commercial or misleading wording anywhere in the rendered surface
    const text = (document.body.textContent ?? '').toLowerCase();
    for (const banned of ['pay', 'bill', 'spread', 'markup', 'booked', 'invoiced', 'realized', 'timesheet', 'revenue']) {
      expect(text).not.toContain(banned);
    }
  });

  it('renders a truthful zero-state with the coverage note still visible', async () => {
    mockFetch({
      eligible_count: 0,
      commercialized_count: 0,
      missing_commercial_count: 0,
      coverage: 'forward_materialized',
      groups: [],
    });
    render(<MarginView sessionOverride={WITH_COMMERCIAL} />);
    await waitFor(() => expect(screen.getByTestId('margin-content')).toBeInTheDocument());
    expect(screen.getByTestId('margin-empty')).toBeInTheDocument();
    expect(screen.getByTestId('margin-coverage-note')).toBeInTheDocument();
    expect(screen.getByTestId('margin-eligible')).toHaveTextContent('0');
  });

  it('does NOT fetch the margin endpoint and shows a SCOPE-SILENT denial when the commercial scope is absent', async () => {
    // useSession bootstraps its own /auth session fetch unconditionally; the gate
    // is that the MARGIN endpoint is never hit when the scope is absent (§26).
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
    );
    const { container } = render(
      <MarginView sessionOverride={WITHOUT_COMMERCIAL} />,
    );
    // T10-B2 FIX_NOW-1 — a safe, scope-SILENT denial: the permission identifier
    // must never be user-visible (the boundary T10-B1 preserved).
    expect(screen.getByTestId('margin-gated')).toBeInTheDocument();
    expect(
      screen.getByText('You do not have access to commercial margin.'),
    ).toBeInTheDocument();
    expect(container.textContent ?? '').not.toContain(
      'assignment:commercials:read',
    );
    expect(document.body.innerHTML).not.toContain('assignment:commercials:read');
    // No-fetch preserved: the gated MARGIN read is never issued.
    const marginCalls = fetchSpy.mock.calls.filter((c) =>
      String(c[0]).includes('/v1/reports/margin'),
    );
    expect(marginCalls).toHaveLength(0);
  });

  it('shows an error state when the request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('boom'));
    render(<MarginView sessionOverride={WITH_COMMERCIAL} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });

  // T9-B5 (§6) — the loading (role="status") state while the mount fetch is in flight
  // (authorized actor only; the gated actor never fetches).
  it('shows the loading state while the request is in flight', async () => {
    // never-resolving fetch keeps the view in the loading state.
    vi.spyOn(globalThis, 'fetch').mockReturnValue(
      new Promise<Response>(() => undefined) as unknown as Promise<Response>,
    );
    render(<MarginView sessionOverride={WITH_COMMERCIAL} />);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });
});
