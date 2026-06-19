import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndexRoute } from './IndexRoute';
import type { DashboardView as DashboardViewModel } from './types';

// IndexRoute spec — the directive's UX intent: actors with dashboard:read
// see the Dashboard; without it, fall back to /requisitions. The
// dispatcher is tiny and substrate-aware (RouteGuard renders
// ForbiddenState on missing scope which would surface a forbidden page
// on the recruiter's home; this dispatcher honors the directive's
// intent without modifying the FROZEN foundation).

function mockSessionAndDashboard(
  scopes: readonly string[],
  dashboardBody?: DashboardViewModel,
) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(
      typeof input === 'string' ? input : (input as URL | Request).toString(),
    );
    if (url.includes('/session')) {
      return new Response(
        JSON.stringify({
          sub: 'u-1',
          consumer_type: 'recruiter',
          tenant_id: 't',
          scopes,
          iat: 0,
          exp: 0,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (url.includes('/v1/dashboard')) {
      return new Response(
        JSON.stringify(
          dashboardBody ?? {
            tenant_counts: {
              companies: 0,
              contacts: 0,
              talent_records: 0,
              saved_lists: 0,
              calendar_events: 0,
              activities: 0,
            },
            requisition_rollup: { total: 0, by_status: [] },
            pipeline_rollup: { total: 0, by_status: [] },
            placement: {
              placed_pipelines: 0,
              includes_core_submittal_placements: false,
            },
            upcoming_events: [],
            recent_activity: [],
          },
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    // My desk also fetches requisitions / tasks / companies; give them
    // valid empty-list shapes so the dispatcher's child renders cleanly.
    return new Response('{"items":[]}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
}

describe('IndexRoute', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the Dashboard for actors with dashboard:read', async () => {
    mockSessionAndDashboard(['dashboard:read']);
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<IndexRoute />} />
          <Route
            path="/requisitions"
            element={<p>REQUISITIONS_FALLBACK</p>}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'My desk' }),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText('REQUISITIONS_FALLBACK')).not.toBeInTheDocument();
  });

  it('falls back to /requisitions for actors WITHOUT dashboard:read (no ForbiddenState on the home)', async () => {
    mockSessionAndDashboard(['requisition:read']);
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<IndexRoute />} />
          <Route
            path="/requisitions"
            element={<p>REQUISITIONS_FALLBACK</p>}
          />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => {
      expect(screen.getByText('REQUISITIONS_FALLBACK')).toBeInTheDocument();
    });
    // Crucially: no ForbiddenState on the home (that would be the wrong
    // UX for an actor whose next-best route is /requisitions).
    expect(screen.queryByText(/forbidden/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'My desk' }),
    ).not.toBeInTheDocument();
  });
});
