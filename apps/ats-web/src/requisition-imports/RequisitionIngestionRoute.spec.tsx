import { RouteGuard, ToastProvider, type Session } from '@aramo/fe-foundation';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminGate } from '../admin/AdminGate';
import { hasAdminScope } from '../admin/admin-access';
import { SettingsShell } from '../settings/SettingsShell';
import { IntegrationsSection } from '../settings/sections/SeamSections';

// T8-P3 Gate-5 FIX_NOW — reachability isolation proof.
//
// Mirrors App.tsx's post-fix routing for `/admin/settings/*`: the requisition-
// ingestion MONITORING route (`admin/settings/integrations/*`) is gated by the
// LOCKED P3 scope `requisition:import:read` via RouteGuard — it is NOT inside
// the `tenant:admin:*` AdminGate subtree that guards every OTHER settings
// section. A more-specific static path out-ranks the `admin/*` splat, so the
// isolated route wins for the integrations path.
//
// The four required proofs:
//   1. recruiter with requisition:import:read (NO admin) reaches P3; list GET occurs.
//   2. actor without requisition:import:read -> P3 surface absent, NO GET.
//   3. non-admin read-holder does NOT gain access to unrelated admin sections.
//   4. admin WITHOUT requisition:import:read -> P3 surface absent, NO fetch.

const IMPORTS_PATH = '/v1/requisition-imports';
const SESSION_PATH = '/auth/recruiter/session';

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

// A fetch double that answers BOTH the component's own useSession probe
// (/auth/recruiter/session — RequisitionIngestionView self-gates on the read
// scope) and the read-only list call (/v1/requisition-imports -> {items:[]}).
function installFetch(session: Session) {
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes(SESSION_PATH)) {
      return new Response(JSON.stringify(session), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes(IMPORTS_PATH)) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(null, { status: 404 });
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    spy as unknown as typeof fetch,
  );
  return spy;
}

function calledWithImports(spy: ReturnType<typeof installFetch>): boolean {
  return spy.mock.calls.some((c) => String(c[0]).includes(IMPORTS_PATH));
}

// Faithful mirror of App.tsx's two sibling routes: the isolated read-scoped P3
// route + a representative admin-only settings section behind AdminGate.
function renderAt(path: string, session: Session) {
  const state = { status: 'authenticated' as const, session };
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="admin/settings/integrations/*"
            element={
              <RouteGuard
                requireScope="requisition:import:read"
                sessionStateOverride={state}
              >
                {hasAdminScope(session) ? (
                  <Routes>
                    <Route element={<SettingsShell />}>
                      <Route index element={<IntegrationsSection />} />
                    </Route>
                  </Routes>
                ) : (
                  <IntegrationsSection />
                )}
              </RouteGuard>
            }
          />
          <Route
            path="admin/*"
            element={
              <AdminGate session={session}>
                <Routes>
                  <Route
                    path="settings/profile"
                    element={<div>ADMIN PROFILE SECTION</div>}
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

describe('T8-P3 requisition-ingestion route reachability', () => {
  // Proof 1 — a recruiter holding ONLY the read scope reaches P3, and the
  // read-only list GET fires. No admin scope present.
  it('lets a recruiter with requisition:import:read (no admin) reach P3 and issues the list GET', async () => {
    const session = makeSession(['requisition:import:read']);
    const fetchSpy = installFetch(session);

    renderAt('/admin/settings/integrations', session);

    await waitFor(() =>
      expect(screen.getByTestId('requisition-ingestion')).toBeInTheDocument(),
    );
    await waitFor(() => expect(calledWithImports(fetchSpy)).toBe(true));

    // The list GET is a GET (read-only), never a mutation.
    const importsCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes(IMPORTS_PATH),
    );
    expect((importsCall?.[1] as RequestInit | undefined)?.method).toBe('GET');

    // No admin scope -> the focused section renders WITHOUT the admin settings
    // rail: no admin IA is exposed to a non-admin.
    expect(screen.queryByTestId('settings-nav-integrations')).not.toBeInTheDocument();
    expect(screen.queryByText(/don't have permission/i)).not.toBeInTheDocument();
  });

  // Proof 2 — an actor lacking the read scope gets ForbiddenState, no surface,
  // and NO list GET.
  it('blocks an actor without requisition:import:read and makes no GET', async () => {
    const session = makeSession(['task:read']);
    const fetchSpy = installFetch(session);

    renderAt('/admin/settings/integrations', session);

    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/requisition:import:read/)).toBeInTheDocument();
    expect(screen.queryByTestId('requisition-ingestion')).not.toBeInTheDocument();

    // Give any stray async effect a tick; the list GET must never fire.
    await Promise.resolve();
    expect(calledWithImports(fetchSpy)).toBe(false);
  });

  // Proof 3 — a non-admin read-holder must NOT gain access to unrelated admin
  // settings sections; those stay behind the tenant:admin:* AdminGate.
  it('does NOT let a non-admin read-holder reach an unrelated admin settings section', () => {
    const session = makeSession(['requisition:import:read']);
    installFetch(session);

    renderAt('/admin/settings/profile', session);

    expect(screen.queryByText('ADMIN PROFILE SECTION')).not.toBeInTheDocument();
    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/tenant:admin:\*/)).toBeInTheDocument();
  });

  // Proof 4 — an admin WITHOUT the read scope is refused P3 (admin alone is not
  // sufficient), with no surface and no fetch.
  it('blocks an admin WITHOUT requisition:import:read from P3 and makes no fetch', async () => {
    const session = makeSession(['tenant:admin:settings']);
    const fetchSpy = installFetch(session);

    renderAt('/admin/settings/integrations', session);

    expect(screen.getByText(/don't have permission/i)).toBeInTheDocument();
    expect(screen.getByText(/requisition:import:read/)).toBeInTheDocument();
    expect(screen.queryByTestId('requisition-ingestion')).not.toBeInTheDocument();

    await Promise.resolve();
    expect(calledWithImports(fetchSpy)).toBe(false);
  });

  // Corollary — an admin who ALSO holds the read scope keeps the full settings
  // rail (IA preserved) and reaches the monitoring surface.
  it('preserves the settings rail for an admin who also holds the read scope', async () => {
    const session = makeSession(['tenant:admin:settings', 'requisition:import:read']);
    installFetch(session);

    renderAt('/admin/settings/integrations', session);

    expect(screen.getByTestId('settings-nav-integrations')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId('requisition-ingestion')).toBeInTheDocument(),
    );
  });
});
