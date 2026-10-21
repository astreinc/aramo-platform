import type { ReactElement } from 'react';
import { type Session } from '@aramo/fe-foundation';
import { DocTemplateRoutesProvider, ORG_DOC_TEMPLATE_ROUTES } from '@aramo/document-templates-web';
import { Navigate, Route, Routes } from 'react-router-dom';

import { canEnterOrg, hasOrgAdminScope, hasOrgTemplateScope } from './access';
import { AuditSection } from './audit/AuditSection';
import { DocumentTemplatesRoutes } from './document-templates/DocumentTemplatesRoutes';
import { DomainSection } from './sections/DomainSection';
import { OrgSettingsSection } from './sections/OrgSeamSections';
import { ProfileSection } from './sections/ProfileSection';
import { SitesSection } from './sections/SitesSection';
import { orgSectionsFor } from './sections';
import { OrgAdminShell } from './shell/OrgAdminShell';
import { UsersListView } from './users/UsersListView';

import './org-admin.css';

// The Organization administration route tree, mounted by apps/home-web at
// `/org/*` (paths below are relative to that mount). ONE gate for the whole
// subtree (hasOrgAdminScope — the `tenant:admin:*` organization family). A
// signed-in member without it is sent to App Home with the denial message
// (accepted App Home handoff §7) — no Organization screen renders first, even
// briefly, because the gate runs before any section mounts. The server is the
// real gate (every section API is @RequireScopes-gated).
export const ORG_DENIED_NOTICE = 'org-denied';

interface OrgAdminRoutesProps {
  readonly session: Session;
}

//
// DOC-TEMPLATE-LIB-1 T-4 (§6.2, §8.2) — the gate also admits a holder of
// document_template:read (the Document templates section only); every organization
// administration section still needs `tenant:admin:*` (a template-only session is sent to
// Document templates instead).
export function OrgAdminRoutes({ session }: OrgAdminRoutesProps) {
  if (!canEnterOrg(session)) {
    return <Navigate to={`/?notice=${ORG_DENIED_NOTICE}`} replace />;
  }
  const admin = hasOrgAdminScope(session);
  const templates = hasOrgTemplateScope(session);
  const home = admin ? 'profile' : 'document-templates';
  const adminOnly = (el: ReactElement) => (admin ? el : <Navigate to="/org/document-templates" replace />);
  return (
    <DocTemplateRoutesProvider routes={ORG_DOC_TEMPLATE_ROUTES}>
      <Routes>
        <Route element={<OrgAdminShell sections={orgSectionsFor({ admin, templates })} />}>
          <Route index element={<Navigate to={home} replace />} />
          <Route path="profile" element={adminOnly(<ProfileSection />)} />
          <Route path="users" element={adminOnly(<UsersListView variant="invitations" />)} />
          <Route path="roles" element={adminOnly(<UsersListView variant="access" />)} />
          <Route path="sites" element={adminOnly(<SitesSection />)} />
          <Route path="domain" element={adminOnly(<DomainSection />)} />
          <Route path="settings" element={adminOnly(<OrgSettingsSection />)} />
          <Route
            path="document-templates/*"
            element={templates ? <DocumentTemplatesRoutes session={session} /> : <Navigate to="/org/profile" replace />}
          />
          <Route path="audit" element={adminOnly(<AuditSection />)} />
          {/* D-ORG paths folded into the accepted section set. */}
          <Route path="security" element={<Navigate to="/org/domain" replace />} />
          <Route path="localization" element={<Navigate to="/org/settings" replace />} />
          <Route path="billing" element={<Navigate to="/org/settings" replace />} />
          <Route path="*" element={<Navigate to={home} replace />} />
        </Route>
      </Routes>
    </DocTemplateRoutesProvider>
  );
}
