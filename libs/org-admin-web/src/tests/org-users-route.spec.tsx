import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgAdminRoutes } from '../OrgAdminRoutes';

// D-ORG-3 — the Organization Administration users surface at /org/users (served
// by apps/home-web). OrgAdminRoutes is the single `tenant:admin:*` family guard
// in front of every /org/* section; the server remains the real gate.
function makeSession(scopes: readonly string[]): Session {
  return {
    sub: 'user-1',
    consumer_type: 'org',
    tenant_id: 'tenant-abc',
    scopes: [...scopes],
    iat: 0,
    exp: 0,
  };
}

function renderAt(path: string, session: Session) {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="org/*" element={<OrgAdminRoutes session={session} />} />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('org users route gating (/org/users)', () => {
  it('blocks a non-admin from the users surface in-UI (ForbiddenState)', () => {
    renderAt('/org/users', makeSession(['talent:read']));
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
    // The Users PageHeader description must not render for a non-admin.
    expect(
      screen.queryByText(/Invite, edit roles, and disable users/i),
    ).not.toBeInTheDocument();
  });

  it('lets an admin reach the ported users list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderAt('/org/users', makeSession(['tenant:admin:user-manage']));
    await waitFor(() =>
      expect(
        screen.getByText(/Invite, edit roles, and disable users/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('the organization rail links Users at /org/users and the index lands on the profile', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderAt('/org', makeSession(['tenant:admin:settings']));
    expect(screen.getByTestId('org-nav-users')).toHaveAttribute('href', '/org/users');
    expect(await screen.findByRole('heading', { name: 'Organization profile' })).toBeInTheDocument();
  });
});
