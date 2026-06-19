import { type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConsentView } from '../consent/ConsentView';

import { AdminGate } from './AdminGate';
import { AdminSection } from './AdminSection';

// Mirrors App.tsx's admin subtree exactly, so this asserts the actual
// route-reachability outcome for the ported consent surface: AdminGate is the
// single `tenant:admin:*` family guard in front of the nested admin Routes.
const TALENT_ID = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

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
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="admin/*"
          element={
            <AdminGate session={session}>
              <Routes>
                <Route index element={<AdminSection />} />
                <Route path="consent/:talentId" element={<ConsentView />} />
              </Routes>
            </AdminGate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('admin consent route gating', () => {
  it('blocks a non-admin from reaching /admin/consent in-UI (ForbiddenState)', () => {
    renderAt(`/admin/consent/${TALENT_ID}`, makeSession(['talent:read']));
    // The consent surface never renders for a non-admin.
    expect(screen.queryByTestId('consent-view')).not.toBeInTheDocument();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
  });

  it('lets an admin reach the ported consent surface', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes('/state/')
        ? { talent_id: TALENT_ID, tenant_id: 't', is_anonymized: false, computed_at: 'x', scopes: [] }
        : { events: [], entries: [], next_cursor: null, is_anonymized: false };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    renderAt(`/admin/consent/${TALENT_ID}`, makeSession(['tenant:admin:settings']));
    await waitFor(() => {
      expect(screen.getByTestId('consent-view')).toBeInTheDocument();
    });
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  it('renders the AdminSection landing (with the consent lookup) at /admin for an admin', () => {
    renderAt('/admin', makeSession(['tenant:admin:settings']));
    expect(screen.getByTestId('admin-consent-talent-id')).toBeInTheDocument();
    expect(screen.getByTestId('admin-consent-open')).toBeInTheDocument();
  });
});
