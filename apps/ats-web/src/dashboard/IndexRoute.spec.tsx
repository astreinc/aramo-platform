import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IndexRoute } from './IndexRoute';

// IndexRoute spec — the directive's UX intent: actors with dashboard:read
// see My Desk; without it, fall back to /requisitions. The dispatcher is tiny
// and substrate-aware (RouteGuard renders ForbiddenState on missing scope which
// would surface a forbidden page on the recruiter's home; this dispatcher
// honors the directive's intent without modifying the FROZEN foundation).

const EMPTY_DESK = {
  generated_at: '2026-09-29T16:00:00.000Z',
  server_date: '2026-09-29',
  priority_items: [],
  interviews_today: [],
  awaiting_client: [],
  exceptions: [],
  requisitions: [],
};

function mockSessionAndDesk(scopes: readonly string[]) {
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
    if (url.includes('/v1/my-desk')) {
      return new Response(JSON.stringify(EMPTY_DESK), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // /v1/me and any other read — a benign shape so the child renders cleanly.
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

  it('renders My Desk for actors with dashboard:read', async () => {
    mockSessionAndDesk(['dashboard:read']);
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
      expect(screen.getByText('Priority queue')).toBeInTheDocument();
    });
    expect(screen.queryByText('REQUISITIONS_FALLBACK')).not.toBeInTheDocument();
  });

  it('falls back to /requisitions for actors WITHOUT dashboard:read (no ForbiddenState on the home)', async () => {
    mockSessionAndDesk(['requisition:read']);
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
    expect(screen.queryByText('Priority queue')).not.toBeInTheDocument();
  });
});
