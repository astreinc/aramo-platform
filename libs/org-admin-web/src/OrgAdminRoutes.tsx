import { ForbiddenState, type Session } from '@aramo/fe-foundation';
import { Navigate, Route, Routes } from 'react-router-dom';

import { hasOrgAdminScope } from './access';
import { AuditSection } from './audit/AuditSection';
import { DomainVerificationSection } from './domain/DomainVerificationSection';
import { RolesSection } from './roles/RolesSection';
import { BillingSection, LocalizationSection, SecuritySection } from './sections/OrgSeamSections';
import { ProfileSection } from './sections/ProfileSection';
import { SitesSection } from './sections/SitesSection';
import { OrgAdminShell } from './shell/OrgAdminShell';
import { UsersListView } from './users/UsersListView';

import './org-admin.css';

// D-ORG-3 — the Organization Administration route tree. Mounted by apps/home-web
// at `/org/*`; every path below is relative to that mount. ONE gate for the whole
// subtree (hasOrgAdminScope — the `tenant:admin:*` organization family); a
// signed-in member without an organization permission gets ForbiddenState (a
// policy outcome, not an authentication failure). The server is the real gate.
interface OrgAdminRoutesProps {
  readonly session: Session;
}

export function OrgAdminRoutes({ session }: OrgAdminRoutesProps) {
  if (!hasOrgAdminScope(session)) {
    return <ForbiddenState scope="tenant:admin:*" />;
  }
  return (
    <Routes>
      <Route element={<OrgAdminShell />}>
        <Route index element={<Navigate to="profile" replace />} />
        <Route path="profile" element={<ProfileSection />} />
        <Route path="sites" element={<SitesSection />} />
        <Route path="domain" element={<DomainVerificationSection />} />
        <Route path="localization" element={<LocalizationSection />} />
        <Route path="users" element={<UsersListView />} />
        <Route path="roles" element={<RolesSection />} />
        <Route path="security" element={<SecuritySection />} />
        <Route path="billing" element={<BillingSection />} />
        <Route path="audit" element={<AuditSection />} />
        <Route path="*" element={<Navigate to="profile" replace />} />
      </Route>
    </Routes>
  );
}
