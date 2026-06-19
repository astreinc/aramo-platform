import { RouteGuard, ToastProvider, useSession } from '@aramo/fe-foundation';
import { Route, Routes } from 'react-router-dom';

import { AdminGate } from './admin/AdminGate';
import { AdminSection } from './admin/AdminSection';
import { CompanyAssignmentsView } from './assignments/CompanyAssignmentsView';
import { RequisitionAssignmentsView } from './assignments/RequisitionAssignmentsView';
import { TeamClientsView } from './assignments/TeamClientsView';
import { CompaniesListView } from './companies/CompaniesListView';
import { CompanyCreateView } from './companies/CompanyCreateView';
import { CompanyDetailView } from './companies/CompanyDetailView';
import { CompanyEditView } from './companies/CompanyEditView';
import { ConsentView } from './consent/ConsentView';
import { ContactCreateView } from './contacts/ContactCreateView';
import { ContactDetailView } from './contacts/ContactDetailView';
import { ContactEditView } from './contacts/ContactEditView';
import { ContactsListView } from './contacts/ContactsListView';
import { EngagementDetailView } from './engagement/EngagementDetailView';
import { IndexRoute } from './dashboard/IndexRoute';
import { LoginPage } from './routes/LoginPage';
import { OrgHierarchyView } from './org/OrgHierarchyView';
import { RequisitionCreateView } from './requisitions/RequisitionCreateView';
import { RequisitionDetailView } from './requisitions/RequisitionDetailView';
import { RequisitionsListView } from './requisitions/RequisitionsListView';
import { SearchView } from './search/SearchView';
import { SettingsView } from './settings/SettingsView';
import { SubmittalWizard } from './submittals/SubmittalWizard';
import { MyTasksView } from './task/MyTasksView';
import { TalentCreateView } from './talent/TalentCreateView';
import { TalentDetailView } from './talent/TalentDetailView';
import { TalentEditView } from './talent/TalentEditView';
import { RecruiterShell } from './shell/RecruiterShell';
import { TalentListView } from './talent/TalentListView';
import { TeamMembersView } from './teams/TeamMembersView';
import { TeamsListView } from './teams/TeamsListView';
import { ShellPreview } from './ui/ShellPreview';
import { UiGallery } from './ui/UiGallery';

export function App() {
  const state = useSession();

  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Design-system showcase (Storybook substitute) + the 2A app-shell
            preview. DEV-only: excluded from production builds; no session/data
            required. */}
        {import.meta.env.DEV ? (
          <Route path="/ui-gallery" element={<UiGallery />} />
        ) : null}
        {import.meta.env.DEV ? (
          <Route path="/ui-shell-preview" element={<ShellPreview />} />
        ) : null}
        <Route
          path="/*"
          element={
            <RouteGuard sessionStateOverride={state}>
              {state.status === 'authenticated' ? (
                <RecruiterShell session={state.session}>
                  <Routes>
                    <Route index element={<IndexRoute />} />
                    {/* Search FE — authenticated-only route (R-NAV); the
                        SearchView does per-section scope-gating internally,
                        so no per-route requireScope here. */}
                    <Route path="search" element={<SearchView />} />
                    <Route
                      path="tasks"
                      element={
                        <RouteGuard
                          requireScope="task:read"
                          sessionStateOverride={state}
                        >
                          <MyTasksView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="requisitions"
                      element={
                        <RouteGuard
                          requireScope="requisition:read"
                          sessionStateOverride={state}
                        >
                          <RequisitionsListView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="requisitions/new"
                      element={
                        <RouteGuard
                          requireScope="requisition:create"
                          sessionStateOverride={state}
                        >
                          <RequisitionCreateView />
                        </RouteGuard>
                      }
                    />
                    {/* PR-A2 P4 — the /requisitions/:reqId/edit route is
                        RETIRED. Editing is now inline in the cockpit
                        (RequisitionDetailView); the form's edit-mode +
                        RequisitionEditView + GenerateProfileDialog are gone. */}
                    <Route
                      path="requisitions/:reqId"
                      element={
                        <RouteGuard
                          requireScope="requisition:read"
                          sessionStateOverride={state}
                        >
                          <RequisitionDetailView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="talent"
                      element={
                        <RouteGuard
                          requireScope="talent:read"
                          sessionStateOverride={state}
                        >
                          <TalentListView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="talent/new"
                      element={
                        <RouteGuard
                          requireScope="talent:create"
                          sessionStateOverride={state}
                        >
                          <TalentCreateView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="talent/:talentId"
                      element={
                        <RouteGuard
                          requireScope="talent:read"
                          sessionStateOverride={state}
                        >
                          <TalentDetailView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="talent/:talentId/edit"
                      element={
                        <RouteGuard
                          requireScope="talent:edit"
                          sessionStateOverride={state}
                        >
                          <TalentEditView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="talent/:talentId/submittal/:requisitionId"
                      element={
                        <RouteGuard
                          requireScope="submittal:create"
                          sessionStateOverride={state}
                        >
                          <SubmittalWizard />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="engagements/:engagementId"
                      element={
                        <RouteGuard
                          requireScope="engagement:read"
                          sessionStateOverride={state}
                        >
                          <EngagementDetailView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="companies"
                      element={
                        <RouteGuard
                          requireScope="company:read"
                          sessionStateOverride={state}
                        >
                          <CompaniesListView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="companies/new"
                      element={
                        <RouteGuard
                          requireScope="company:create"
                          sessionStateOverride={state}
                        >
                          <CompanyCreateView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="companies/:companyId"
                      element={
                        <RouteGuard
                          requireScope="company:read"
                          sessionStateOverride={state}
                        >
                          <CompanyDetailView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="companies/:companyId/edit"
                      element={
                        <RouteGuard
                          requireScope="company:edit"
                          sessionStateOverride={state}
                        >
                          <CompanyEditView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="contacts"
                      element={
                        <RouteGuard
                          requireScope="contact:read"
                          sessionStateOverride={state}
                        >
                          <ContactsListView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="contacts/:contactId"
                      element={
                        <RouteGuard
                          requireScope="contact:read"
                          sessionStateOverride={state}
                        >
                          <ContactDetailView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="companies/:companyId/contacts/new"
                      element={
                        <RouteGuard
                          requireScope="contact:create"
                          sessionStateOverride={state}
                        >
                          <ContactCreateView />
                        </RouteGuard>
                      }
                    />
                    <Route
                      path="contacts/:contactId/edit"
                      element={
                        <RouteGuard
                          requireScope="contact:edit"
                          sessionStateOverride={state}
                        >
                          <ContactEditView />
                        </RouteGuard>
                      }
                    />
                    {/* Admin-gated section. AdminGate is the single
                        `tenant:admin:*` family guard for the whole subtree (a
                        non-admin reaching any /admin route in-UI gets
                        ForbiddenState; the server is the real gate). The nested
                        Routes host the ported admin modules — consent is the
                        first (FE Consolidation Directive 2); more port in
                        subsequent directives. */}
                    <Route
                      path="admin/*"
                      element={
                        <AdminGate session={state.session}>
                          <Routes>
                            <Route index element={<AdminSection />} />
                            <Route path="settings" element={<SettingsView />} />
                            <Route path="org" element={<OrgHierarchyView />} />
                            <Route
                              path="consent/:talentId"
                              element={<ConsentView />}
                            />
                            <Route
                              path="companies/:companyId/assignments"
                              element={<CompanyAssignmentsView />}
                            />
                            <Route
                              path="requisitions/:requisitionId/assignments"
                              element={<RequisitionAssignmentsView />}
                            />
                            <Route path="teams" element={<TeamsListView />} />
                            <Route
                              path="teams/:teamId"
                              element={<TeamMembersView />}
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
                </RecruiterShell>
              ) : null}
            </RouteGuard>
          }
        />
      </Routes>
    </ToastProvider>
  );
}
