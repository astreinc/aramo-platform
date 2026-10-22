import { OrgPageHeader } from '../ui/OrgPage';

import { TenantProfileForm } from './TenantProfileForm';

// ORG-UX-1 (Directive v1.0 LOCKED §8.2; handoff §6.2) — Profile: the logo card, the four
// form cards and the sticky unsaved-changes bar (TenantProfileForm). Admin-only (the
// route gates on the server's org_access).
export function ProfilePage() {
  return (
    <>
      <OrgPageHeader section="profile" />
      <TenantProfileForm />
    </>
  );
}
