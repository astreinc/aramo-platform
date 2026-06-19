import { type Session } from '@aramo/fe-foundation';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AdminGate } from './AdminGate';
import { AdminSection } from './AdminSection';

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

// Mirrors how App.tsx wires the admin subtree, so this asserts the actual
// route-reachability outcome a principal hits when navigating to /admin.
function renderAdminRoute(session: Session) {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route path="/other" element={<p>elsewhere</p>} />
        <Route
          path="admin/*"
          element={
            <AdminGate session={session}>
              <AdminSection />
            </AdminGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminGate (the /admin/* subtree guard)', () => {
  it('renders the admin section for a tenant:admin-scoped principal', () => {
    renderAdminRoute(makeSession(['talent:read', 'tenant:admin:settings']));
    expect(screen.getByRole('heading', { name: 'Administration' })).toBeInTheDocument();
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('blocks a non-admin principal in-UI with ForbiddenState (server is the real gate)', () => {
    renderAdminRoute(
      makeSession(['requisition:read', 'talent:read', 'company:read', 'task:read']),
    );
    // The route is not reachable in-UI: the section never renders.
    expect(screen.queryByRole('heading', { name: 'Administration' })).not.toBeInTheDocument();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
  });
});
