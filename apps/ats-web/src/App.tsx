import { RouteGuard, ToastProvider, useSession } from '@aramo/fe-foundation';
import { Navigate, Route, Routes } from 'react-router-dom';

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
import { IdentityAdvisoriesView } from './identity-advisories/IdentityAdvisoriesView';
import { IndexRoute } from './dashboard/IndexRoute';
import { InvitationAcceptPage } from './routes/InvitationAcceptPage';
import { LoginPage } from './routes/LoginPage';
import { OrgHierarchyView } from './org/OrgHierarchyView';
import { RequisitionCreateView } from './requisitions/RequisitionCreateView';
import { RequisitionDetailView } from './requisitions/RequisitionDetailView';
import { RequisitionsListView } from './requisitions/RequisitionsListView';
import { SearchView } from './search/SearchView';
import { SourcingPoolView } from './sourcing/SourcingPoolView';
import { SettingsView } from './settings/SettingsView';
import { SettingsShell } from './settings/SettingsShell';
import { TenantProfileSection } from './settings/sections/TenantProfileSection';
import { BranchesSection } from './settings/sections/BranchesSection';
import { ImportSection } from './settings/sections/ImportSection';
import { ComplianceSection } from './settings/sections/ComplianceSection';
import {
  ApplySection,
  BillingSection,
  EmailSection,
  FieldsSection,
  IntegrationsSection,
  LocalizationSection,
  PortalSection,
  SecuritySection,
} from './settings/sections/SeamSections';
import { AuditSection } from './settings/audit/AuditSection';
import { DomainVerificationSection } from './settings/sections/DomainVerificationSection';
import { RolesSection } from './settings/roles/RolesSection';
import { SubmittalWizard } from './submittals/SubmittalWizard';
import { MyTasksView } from './task/MyTasksView';
import { TalentCreateView } from './talent/TalentCreateView';
import { TalentDetailView } from './talent/TalentDetailView';
import { TalentEditView } from './talent/TalentEditView';
import { RecruiterShell } from './shell/RecruiterShell';
import { TalentListView } from './talent/TalentListView';
import { TeamMembersView } from './teams/TeamMembersView';
import { TeamsListView } from './teams/TeamsListView';
import { UsersListView } from './users/UsersListView';
import { ShellPreview } from './ui/ShellPreview';
import { UiGallery } from './ui/UiGallery';

export function App() {
  const state = useSession();

  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* Invite-S3 (§5) — the PUBLIC invitation-accept page. Top-level,
            BEFORE the path="/*" catch-all and OUTSIDE RouteGuard (mirrors
            /login) so it renders session-less. */}
        <Route
          path="/invitations/accept"
          element={<InvitationAcceptPage />}
        />
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
                    {/* Promotion-Trigger slice B-ui — the sourcing pool. The
                        subject detail is a DRAWER (not a route), opened from the
                        queue; promotion is detail-gated. talent:source. */}
                    <Route
                      path="sourcing"
                      element={
                        <RouteGuard
                          requireScope="talent:source"
                          sessionStateOverride={state}
                        >
                          <SourcingPoolView />
                        </RouteGuard>
                      }
                    />
                    {/* TR-6 B2 — the identity-advisory reviewer worklist. A
                        route-level surface (not a drawer); resolving a pair
                        reuses the shared AdvisoryResolveDialog. identity:resolve. */}
                    <Route
                      path="identity/advisories"
                      element={
                        <RouteGuard
                          requireScope="identity:resolve"
                          sessionStateOverride={state}
                        >
                          <IdentityAdvisoriesView />
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
                        ForbiddenState; the server is the real gate).
                        Settings Rebuild Directive 1: the whole subtree now
                        renders inside <SettingsShell> — the six-group settings
                        rail (consolidation pattern) + <Outlet/>. The built
                        modules (Users / Teams / Org) are re-homed as live
                        sections at their existing paths; the new section routes
                        host the live Import/Export/Defaults surfaces + the
                        honest seams. The per-record deep links (consent +
                        assignment editors) stay as separate surfaces reached
                        from the residual admin-tools landing (/admin/tools). */}
                    <Route
                      path="admin/*"
                      element={
                        <AdminGate session={state.session}>
                          <Routes>
                            <Route element={<SettingsShell />}>
                              <Route
                                index
                                element={
                                  <Navigate to="/admin/settings/profile" replace />
                                }
                              />
                              {/* Re-homed live modules (render in-shell at
                                  their existing, test-covered paths). */}
                              <Route path="users" element={<UsersListView />} />
                              <Route path="org" element={<OrgHierarchyView />} />
                              <Route path="teams" element={<TeamsListView />} />
                              <Route
                                path="teams/:teamId"
                                element={<TeamMembersView />}
                              />
                              <Route
                                path="teams/:teamId/clients"
                                element={<TeamClientsView />}
                              />
                              {/* Existing Defaults route preserved (back-compat
                                  + its route test). */}
                              <Route path="settings" element={<SettingsView />} />
                              {/* The settings sections. */}
                              <Route
                                path="settings/profile"
                                element={<TenantProfileSection />}
                              />
                              <Route
                                path="settings/branches"
                                element={<BranchesSection />}
                              />
                              <Route
                                path="settings/localization"
                                element={<LocalizationSection />}
                              />
                              <Route
                                path="settings/roles"
                                element={<RolesSection />}
                              />
                              <Route
                                path="settings/security"
                                element={<SecuritySection />}
                              />
                              <Route
                                path="settings/domain"
                                element={<DomainVerificationSection />}
                              />
                              <Route
                                path="settings/portal"
                                element={<PortalSection />}
                              />
                              <Route
                                path="settings/apply"
                                element={<ApplySection />}
                              />
                              <Route
                                path="settings/email"
                                element={<EmailSection />}
                              />
                              <Route
                                path="settings/import"
                                element={<ImportSection />}
                              />
                              <Route
                                path="settings/compliance"
                                element={<ComplianceSection />}
                              />
                              <Route
                                path="settings/fields"
                                element={<FieldsSection />}
                              />
                              <Route
                                path="settings/integrations"
                                element={<IntegrationsSection />}
                              />
                              <Route
                                path="settings/billing"
                                element={<BillingSection />}
                              />
                              <Route
                                path="settings/audit"
                                element={<AuditSection />}
                              />
                              {/* Residual admin-tools (Lead ruling C): consent +
                                  assignment-discovery lookups stay reachable. */}
                              <Route path="tools" element={<AdminSection />} />
                              {/* Per-record deep links (unchanged contracts). */}
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
                            </Route>
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
