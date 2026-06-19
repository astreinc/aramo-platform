import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsersListView } from '../users/UsersListView';

import { AdminGate } from './AdminGate';
import { AdminSection } from './AdminSection';

// Mirrors App.tsx's admin subtree for the ported users surface: AdminGate is
// the single `tenant:admin:*` family guard in front of the nested route.
function makeSession(scopes: readonly string[]): Session {
  return {
    sub: 'user-1',
    consumer_type: 'recruiter',
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
          <Route
            path="admin/*"
            element={
              <AdminGate session={session}>
                <Routes>
                  <Route index element={<AdminSection />} />
                  <Route path="users" element={<UsersListView />} />
                </Routes>
              </AdminGate>
            }
          />
        </Routes>
      </MemoryRouter>
    </ToastProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('admin users route gating', () => {
  it('blocks a non-admin from the users surface in-UI (ForbiddenState)', () => {
    renderAt('/admin/users', makeSession(['talent:read']));
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
    renderAt('/admin/users', makeSession(['tenant:admin:user-manage']));
    await waitFor(() =>
      expect(
        screen.getByText(/Invite, edit roles, and disable users/i),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('surfaces the users link on the admin landing for an admin', () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    const link = screen.getByTestId('admin-users-link');
    expect(link).toHaveAttribute('href', '/admin/users');
  });
});
