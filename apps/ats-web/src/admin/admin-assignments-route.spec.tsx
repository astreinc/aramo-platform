import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CompanyAssignmentsView } from '../assignments/CompanyAssignmentsView';
import { RequisitionAssignmentsView } from '../assignments/RequisitionAssignmentsView';
import { TeamClientsView } from '../assignments/TeamClientsView';

import { AdminGate } from './AdminGate';
import { AdminSection } from './AdminSection';

// Mirrors App.tsx's admin subtree for the ported assignment editors: AdminGate
// is the single `tenant:admin:*` family guard in front of the nested routes.
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
                  <Route
                    path="companies/:companyId/assignments"
                    element={<CompanyAssignmentsView />}
                  />
                  <Route
                    path="requisitions/:requisitionId/assignments"
                    element={<RequisitionAssignmentsView />}
                  />
                  <Route
                    path="teams/:teamId/clients"
                    element={<TeamClientsView />}
                  />
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

const NON_ADMIN = ['company:assign', 'requisition:assign', 'team:manage'];

describe('admin assignments route gating', () => {
  it('blocks a non-admin from every assignment editor in-UI (ForbiddenState)', () => {
    for (const path of [
      '/admin/companies/c-1/assignments',
      '/admin/requisitions/r-1/assignments',
      '/admin/teams/t-1/clients',
    ]) {
      const { unmount } = renderAt(path, makeSession(NON_ADMIN));
      expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
      expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
      expect(screen.queryByText('Company assignments')).not.toBeInTheDocument();
      expect(screen.queryByText('Requisition assignments')).not.toBeInTheDocument();
      expect(screen.queryByText('Team clients')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('lets an admin reach the ported assignment editors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    renderAt('/admin/companies/c-1/assignments', makeSession(['tenant:admin:settings']));
    await waitFor(() =>
      expect(screen.getByText('Company assignments')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('surfaces the assignment ID-lookups on the admin landing for an admin', () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    expect(screen.getByTestId('admin-company-assign-open')).toBeInTheDocument();
    expect(screen.getByTestId('admin-req-assign-open')).toBeInTheDocument();
    expect(screen.getByTestId('admin-team-clients-open')).toBeInTheDocument();
  });
});
