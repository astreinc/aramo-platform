import {
  RouteGuard,
  Shell,
  ToastProvider,
  useSession,
  type ShellNavItem,
} from '@aramo/fe-foundation';
import { Route, Routes } from 'react-router-dom';

import { CompanyAssignmentsView } from './assignments/CompanyAssignmentsView';
import { RequisitionAssignmentsView } from './assignments/RequisitionAssignmentsView';
import { TeamClientsView } from './assignments/TeamClientsView';
import { OrgHierarchyView } from './org/OrgHierarchyView';
import { LandingPage } from './routes/LandingPage';
import { LoginPage } from './routes/LoginPage';
import { SettingsView } from './settings/SettingsView';
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
  { to: '/settings', label: 'Settings', requireScope: 'tenant:admin:settings' },
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
                        nav). tenant-console is not yet retired; remaining
                        admin modules port in subsequent directives. */}
                    <Route
                      path="settings"
                      element={
                        <RouteGuard
                          requireScope="tenant:admin:settings"
                          sessionStateOverride={state}
                        >
                          <SettingsView />
                        </RouteGuard>
                      }
                    />
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
                    <Route
                      path="teams/:teamId/clients"
                      element={
                        <RouteGuard
                          requireScope="team:manage"
                          sessionStateOverride={state}
                        >
                          <TeamClientsView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="companies/:companyId/assignments"
                      element={
                        <RouteGuard
                          requireScope="company:assign"
                          sessionStateOverride={state}
                        >
                          <CompanyAssignmentsView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="requisitions/:requisitionId/assignments"
                      element={
                        <RouteGuard
                          requireScope="requisition:assign"
                          sessionStateOverride={state}
                        >
                          <RequisitionAssignmentsView />
                        </RouteGuard>
                      }
                    />
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
