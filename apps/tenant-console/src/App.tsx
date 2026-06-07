import { Route, Routes } from 'react-router-dom';

import { CompanyAssignmentsView } from './assignments/CompanyAssignmentsView';
import { RequisitionAssignmentsView } from './assignments/RequisitionAssignmentsView';
import { TeamClientsView } from './assignments/TeamClientsView';
import { RouteGuard } from './auth/RouteGuard';
import { useSession } from './auth/session';
import { ToastProvider } from './components/Toast';
import { ConsentView } from './consent/ConsentView';
import { LandingPage } from './routes/LandingPage';
import { LoginPage } from './routes/LoginPage';
import { OrgHierarchyView } from './org/OrgHierarchyView';
import { SettingsView } from './settings/SettingsView';
import { Shell } from './shell/Shell';
import { TeamMembersView } from './teams/TeamMembersView';
import { TeamsListView } from './teams/TeamsListView';
import { UsersListView } from './users/UsersListView';

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
                <Shell session={state.session}>
                  <Routes>
                    <Route
                      index
                      element={<LandingPage session={state.session} />}
                    />
                    <Route
                      path="consent/:talentId"
                      element={<ConsentView />}
                    />
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
