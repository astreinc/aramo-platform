import { ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsView } from '../settings/SettingsView';

import { AdminGate } from './AdminGate';
import { AdminSection } from './AdminSection';

// Mirrors App.tsx's admin subtree for the ported settings surface: AdminGate is
// the single `tenant:admin:*` family guard in front of the nested admin Routes.
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
                  <Route path="settings" element={<SettingsView />} />
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

describe('admin settings route gating', () => {
  it('blocks a non-admin from reaching /admin/settings in-UI (ForbiddenState)', () => {
    renderAt('/admin/settings', makeSession(['talent:read']));
    expect(screen.queryByText('Compensation display')).not.toBeInTheDocument();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
  });

  it('lets an admin reach the ported settings surface', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          'compensation.display_default': 'both',
          'audit.financials_enabled': false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    renderAt('/admin/settings', makeSession(['tenant:admin:settings']));
    await waitFor(() =>
      expect(screen.getByText('Compensation display')).toBeInTheDocument(),
    );
    expect(screen.getByText('Financial-auditor grant')).toBeInTheDocument();
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('surfaces a settings link on the admin landing for an admin', () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    const link = screen.getByTestId('admin-settings-link');
    expect(link).toHaveAttribute('href', '/admin/settings');
  });
});
