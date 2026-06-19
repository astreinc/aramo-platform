import {
  RouteGuard,
  Shell,
  ToastProvider,
  useSession,
  type ShellNavItem,
} from '@aramo/fe-foundation';
import { Route, Routes } from 'react-router-dom';

import { LandingPage } from './routes/LandingPage';
import { LoginPage } from './routes/LoginPage';
import { UsersListView } from './users/UsersListView';

// The tenant-console nav. Each item is rendered by Shell only when the
// session carries `requireScope` (the S5a hasScope axis at the nav
// boundary). Order is the original Shell.tsx order, preserved at
// repoint so the rendered nav is byte-identical to pre-extraction.
const TENANT_CONSOLE_NAV: readonly ShellNavItem[] = [
  { to: '/users', label: 'Users', requireScope: 'tenant:admin:user-manage' },
];

export function App() {
  const state = useSession();

  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/*"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? (
                <Shell
                  session={state.session}
                  brand="Aramo · Tenant Console"
                  navItems={TENANT_CONSOLE_NAV}
                >
                  <Routes>
                    <Route
                      index
                      element={<LandingPage session={state.session} />}
                    />
                    {/* Consent surface ported to ats-web /admin/consent
                        (FE Consolidation Directive 2). Removed here — the
                        module was cleanly decoupled (apiClient + ApiError
                        only) and direct-URL-only (never in tenant-console
                        nav). Settings likewise ported to ats-web /admin/settings
                        (Directive 3) — route + nav item removed here.
                        tenant-console is not yet retired; remaining admin
                        modules port in subsequent directives. */}
                    <Route
                      path="users"
                      element={
                        <RouteGuard
                          requireScope="tenant:admin:user-manage"
                          sessionStateOverride={state}
                        >
                          <UsersListView />
                        </RouteGuard>
                      }
                    />
                    {/* Org / teams / assignments / settings / consent all
                        ported to ats-web /admin (FE Consolidation Directives
                        2–5). Only users remains here; tenant-console retires in
                        Directive 5 PR4 once users ports. */}
                  </Routes>
                </Shell>
              ) : null}
            </RouteGuard>
          }
        />
      </Routes>
    </ToastProvider>
  );
}
