import {
  RouteGuard,
  Shell,
  ToastProvider,
  useSession,
  type ShellNavItem,
} from '@aramo/fe-foundation';
import { Route, Routes } from 'react-router-dom';

import { OrgHierarchyView } from './org/OrgHierarchyView';
import { LandingPage } from './routes/LandingPage';
import { LoginPage } from './routes/LoginPage';
import { TeamMembersView } from './teams/TeamMembersView';
import { TeamsListView } from './teams/TeamsListView';
import { UsersListView } from './users/UsersListView';

// The tenant-console nav. Each item is rendered by Shell only when the
// session carries `requireScope` (the S5a hasScope axis at the nav
// boundary). Order is the original Shell.tsx order, preserved at
// repoint so the rendered nav is byte-identical to pre-extraction.
const TENANT_CONSOLE_NAV: readonly ShellNavItem[] = [
  { to: '/users', label: 'Users', requireScope: 'tenant:admin:user-manage' },
  { to: '/org', label: 'Organisation', requireScope: 'org:manage' },
  { to: '/teams', label: 'Teams', requireScope: 'team:manage' },
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
                    <Route
                      path="org"
                      element={
                        <RouteGuard
                          requireScope="org:manage"
                          sessionStateOverride={state}
                        >
                          <OrgHierarchyView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="teams"
                      element={
                        <RouteGuard
                          requireScope="team:manage"
                          sessionStateOverride={state}
                        >
                          <TeamsListView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="teams/:teamId"
                      element={
                        <RouteGuard
                          requireScope="team:manage"
                          sessionStateOverride={state}
                        >
                          <TeamMembersView />
                        </RouteGuard>
                      }
                    />
                    {/* Assignments (company / requisition / team-clients
                        editors) ported to ats-web /admin (FE Consolidation
                        Directive 4). Routes removed here; the "Manage clients"
                        link in TeamMembersView is de-wired to match. NOT
                        cleanly decoupled on removal — tenant-console's teams
                        module deep-linked TeamClientsView — so the teams port
                        will re-home that link to the ats-web admin route.
                        tenant-console not yet retired. */}
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
