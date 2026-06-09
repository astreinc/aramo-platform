import {
  RouteGuard,
  Shell,
  ToastProvider,
  useSession,
  type ShellNavItem,
} from '@aramo/fe-foundation';
import { Navigate, Route, Routes } from 'react-router-dom';

import { CompaniesListView } from './companies/CompaniesListView';
import { CompanyCreateView } from './companies/CompanyCreateView';
import { CompanyDetailView } from './companies/CompanyDetailView';
import { CompanyEditView } from './companies/CompanyEditView';
import { ContactCreateView } from './contacts/ContactCreateView';
import { ContactEditView } from './contacts/ContactEditView';
import { LoginPage } from './routes/LoginPage';
import { RequisitionCreateView } from './requisitions/RequisitionCreateView';
import { RequisitionDetailView } from './requisitions/RequisitionDetailView';
import { RequisitionEditView } from './requisitions/RequisitionEditView';
import { RequisitionsListView } from './requisitions/RequisitionsListView';
import { SubmittalWizard } from './submittals/SubmittalWizard';
import { TalentCreateView } from './talent/TalentCreateView';
import { TalentDetailView } from './talent/TalentDetailView';
import { TalentEditView } from './talent/TalentEditView';
import { TalentListView } from './talent/TalentListView';

// The recruiter nav. R1 shipped Requisitions; R2 adds Talent + Companies
// (the read-first breadth). Each item is scope-gated by its read scope —
// Shell renders only the items the session's scopes allow.
const RECRUITER_NAV: readonly ShellNavItem[] = [
  {
    to: '/requisitions',
    label: 'Requisitions',
    requireScope: 'requisition:read',
  },
  {
    to: '/talent',
    label: 'Talent',
    requireScope: 'talent:read',
  },
  {
    to: '/companies',
    label: 'Companies',
    requireScope: 'company:read',
  },
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
                  brand="Aramo · Recruiter Console"
                  navItems={RECRUITER_NAV}
                >
                  <Routes>
                    <Route
                      index
                      element={<Navigate to="/requisitions" replace />}
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
                      path="requisitions/:reqId/edit"
                      element={
                        <RouteGuard
                          requireScope="requisition:edit"
                          sessionStateOverride={state}
                        >
                          <RequisitionEditView />
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
                </Shell>
              ) : null}
            </RouteGuard>
          }
        />
      </Routes>
    </ToastProvider>
  );
}
