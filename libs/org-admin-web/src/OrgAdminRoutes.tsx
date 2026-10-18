import { type Session } from '@aramo/fe-foundation';
import { Navigate, Route, Routes } from 'react-router-dom';

import { hasOrgAdminScope } from './access';
import { AuditSection } from './audit/AuditSection';
import { DomainSection } from './sections/DomainSection';
import { OrgSettingsSection } from './sections/OrgSeamSections';
import { ProfileSection } from './sections/ProfileSection';
import { SitesSection } from './sections/SitesSection';
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

export function OrgAdminRoutes({ session }: OrgAdminRoutesProps) {
  if (!hasOrgAdminScope(session)) {
    return <Navigate to={`/?notice=${ORG_DENIED_NOTICE}`} replace />;
  }
  return (
    <Routes>
      <Route element={<OrgAdminShell />}>
        <Route index element={<Navigate to="profile" replace />} />
        <Route path="profile" element={<ProfileSection />} />
        <Route path="users" element={<UsersListView variant="invitations" />} />
        <Route path="roles" element={<UsersListView variant="access" />} />
        <Route path="sites" element={<SitesSection />} />
        <Route path="domain" element={<DomainSection />} />
        <Route path="settings" element={<OrgSettingsSection />} />
        <Route path="audit" element={<AuditSection />} />
        {/* D-ORG paths folded into the accepted section set. */}
        <Route path="security" element={<Navigate to="/org/domain" replace />} />
        <Route path="localization" element={<Navigate to="/org/settings" replace />} />
        <Route path="billing" element={<Navigate to="/org/settings" replace />} />
        <Route path="*" element={<Navigate to="profile" replace />} />
      </Route>
    </Routes>
  );
}
