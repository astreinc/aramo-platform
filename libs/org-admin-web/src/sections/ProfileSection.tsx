import { SettingsSection } from '@aramo/fe-foundation';

import { TenantProfileForm } from '../profile/TenantProfileForm';

// D-ORG-3 — Organization profile (the organization's identity: legal/display
// name, address, country; GET/PATCH /v1/tenant/profile, tenant:admin:profile).
// Relocated from ATS Settings → Tenant profile. The ATS "Defaults" card that
// used to share that page (compensation display + the financials grant) is
// RECRUITING configuration and stayed in the ATS (Settings → Recruiting).
export function ProfileSection() {
  return (
    <SettingsSection
      title="Organization profile"
      description="Your organization's identity and details — shared by every Aramo product your organization uses."
    >
      <TenantProfileForm />
    </SettingsSection>
  );
}
