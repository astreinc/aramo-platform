import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamMembersView } from '../teams/TeamMembersView';
import { TeamsListView } from '../teams/TeamsListView';

import { AdminGate } from './AdminGate';
import { AdminSection } from './AdminSection';

// Mirrors App.tsx's admin subtree for the ported teams surfaces: AdminGate is
// the single `tenant:admin:*` family guard in front of the nested routes.
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
                  <Route path="teams" element={<TeamsListView />} />
                  <Route path="teams/:teamId" element={<TeamMembersView />} />
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

describe('admin teams route gating', () => {
  it('blocks a non-admin from the teams surfaces in-UI (ForbiddenState)', () => {
    for (const path of ['/admin/teams', '/admin/teams/t-1']) {
      const { unmount } = renderAt(path, makeSession(['team:manage']));
      expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
      expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
      expect(screen.queryByText('Teams')).not.toBeInTheDocument();
      expect(screen.queryByText('Team members')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('lets an admin reach the ported teams list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderAt('/admin/teams', makeSession(['tenant:admin:settings']));
    await waitFor(() => expect(screen.getByText('Teams')).toBeInTheDocument());
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('surfaces the teams link on the admin landing for an admin', () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    const link = screen.getByTestId('admin-teams-link');
    expect(link).toHaveAttribute('href', '/admin/teams');
  });
});
