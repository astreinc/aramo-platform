import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OrgHierarchyView } from '../org/OrgHierarchyView';

import { AdminGate } from './AdminGate';
import { AdminSection } from './AdminSection';

// Mirrors App.tsx's admin subtree for the ported org surface: AdminGate is the
// single `tenant:admin:*` family guard in front of the nested route.
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
                  <Route path="org" element={<OrgHierarchyView />} />
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

describe('admin org route gating', () => {
  it('blocks a non-admin from the org hierarchy in-UI (ForbiddenState)', () => {
    renderAt('/admin/org', makeSession(['org:manage']));
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
    expect(screen.queryByText('Organisation hierarchy')).not.toBeInTheDocument();
  });

  it('lets an admin reach the ported org hierarchy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderAt('/admin/org', makeSession(['tenant:admin:settings']));
    await waitFor(() =>
      expect(screen.getByText('Organisation hierarchy')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('surfaces the organisation link on the admin landing for an admin', () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    const link = screen.getByTestId('admin-org-link');
    expect(link).toHaveAttribute('href', '/admin/org');
  });
});
