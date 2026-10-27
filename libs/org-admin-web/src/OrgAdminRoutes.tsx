import type { ReactElement } from 'react';
import { type Session } from '@aramo/fe-foundation';
import { DocTemplateRoutesProvider, ORG_DOC_TEMPLATE_ROUTES } from '@aramo/document-templates-web';
import { Navigate, Route, Routes } from 'react-router-dom';

import { useOrgAccess } from './access';
import { AuditPage } from './audit/AuditPage';
import { DocumentTemplatesRoutes } from './document-templates/DocumentTemplatesRoutes';
import { DomainPage } from './domain/DomainPage';
import { OverviewPage } from './overview/OverviewPage';
import { ProfilePage } from './profile/ProfilePage';
import { RolesAccessPage } from './users/RolesAccessPage';
import { SettingsPage } from './settings/SettingsPage';
import { SitesPage } from './sites/SitesPage';
import { OrgAdminShell } from './shell/OrgAdminShell';
import { UsersInvitationsPage } from './users/UsersInvitationsPage';

import './org-admin.css';

// ORG-UX-1 (Directive v1.0 LOCKED §3, §4.3; handoff rev. Oct 21 §3) — the Organization
// route tree, mounted by apps/home-web at `/org/*`. Paths (production's, H10/P6):
//   /org, /org/overview           Overview (the default)
//   /org/profile · users · roles · sites · domain · settings · audit
//   /org/document-templates       Our templates     (+ new, aramo/:id, :id, :id/draft)
//   /org/document-templates/gallery  Template gallery
// Who may open what is the SERVER's answer (GET /v1/me/products → org_access, the ADR-0035
// role model — Lead Correction A): admin = every section; templates = Our templates +
// gallery; none = App Home with the existing denial notice. Nothing renders until the answer
// arrives (no flash of an Organization screen). Every section API stays @RequireScopes-gated.
export const ORG_DENIED_NOTICE = 'org-denied';

interface OrgAdminRoutesProps {
  readonly session: Session;
}

export function OrgAdminRoutes({ session }: OrgAdminRoutesProps) {
  const access = useOrgAccess();
  if (access.status === 'loading') return <div className="ox-page" aria-busy="true" data-testid="org-loading" />;
  if (access.status === 'error') {
    return (
      <div className="ox-page" role="alert">
        <p>We couldn’t check your organization access. </p>
        <button type="button" className="ox-btn ox-btn--secondary" onClick={access.retry}>
          Try again
        </button>
      </div>
    );
  }
  if (access.access === 'none') return <Navigate to={`/?notice=${ORG_DENIED_NOTICE}`} replace />;
  const admin = access.access === 'admin';
  const home = admin ? '/org/overview' : '/org/document-templates';
  const adminOnly = (el: ReactElement) => (admin ? el : <Navigate to={`/?notice=${ORG_DENIED_NOTICE}`} replace />);
  return (
    <DocTemplateRoutesProvider routes={ORG_DOC_TEMPLATE_ROUTES}>
      <Routes>
        <Route element={<OrgAdminShell products={access.products} />}>
          <Route index element={<Navigate to={home} replace />} />
          <Route path="overview" element={adminOnly(<OverviewPage session={session} />)} />
          <Route path="profile" element={adminOnly(<ProfilePage />)} />
          <Route path="users" element={adminOnly(<UsersInvitationsPage session={session} products={access.products} />)} />
          <Route path="roles" element={adminOnly(<RolesAccessPage session={session} products={access.products} />)} />
          <Route path="sites" element={adminOnly(<SitesPage />)} />
          <Route path="domain" element={adminOnly(<DomainPage />)} />
          <Route path="settings" element={adminOnly(<SettingsPage />)} />
          <Route path="document-templates/*" element={<DocumentTemplatesRoutes session={session} organizationHref={admin ? '/org/overview' : null} admin={admin} />} />
          <Route path="audit" element={adminOnly(<AuditPage />)} />
          {/* D-ORG paths folded into the section set. */}
          <Route path="security" element={<Navigate to="/org/domain" replace />} />
          <Route path="localization" element={<Navigate to="/org/settings" replace />} />
          <Route path="billing" element={<Navigate to="/org/settings" replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </DocTemplateRoutesProvider>
  );
}
