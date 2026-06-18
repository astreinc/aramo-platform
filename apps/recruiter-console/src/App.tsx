import { RouteGuard, ToastProvider, useSession } from '@aramo/fe-foundation';
import { Route, Routes } from 'react-router-dom';

import { CompaniesListView } from './companies/CompaniesListView';
import { CompanyCreateView } from './companies/CompanyCreateView';
import { CompanyDetailView } from './companies/CompanyDetailView';
import { CompanyEditView } from './companies/CompanyEditView';
import { ContactCreateView } from './contacts/ContactCreateView';
import { ContactDetailView } from './contacts/ContactDetailView';
import { ContactEditView } from './contacts/ContactEditView';
import { ContactsListView } from './contacts/ContactsListView';
import { EngagementDetailView } from './engagement/EngagementDetailView';
import { IndexRoute } from './dashboard/IndexRoute';
import { LoginPage } from './routes/LoginPage';
import { RequisitionCreateView } from './requisitions/RequisitionCreateView';
import { RequisitionDetailView } from './requisitions/RequisitionDetailView';
import { RequisitionsListView } from './requisitions/RequisitionsListView';
import { SearchView } from './search/SearchView';
import { SubmittalWizard } from './submittals/SubmittalWizard';
import { MyTasksView } from './task/MyTasksView';
import { TalentCreateView } from './talent/TalentCreateView';
import { TalentDetailView } from './talent/TalentDetailView';
import { TalentEditView } from './talent/TalentEditView';
import { RecruiterShell } from './shell/RecruiterShell';
import { TalentListView } from './talent/TalentListView';
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
