import { SettingsSection } from '@aramo/fe-foundation';

import { DomainVerificationPanel } from '../domain/DomainVerificationPanel';

import { SsoSeam } from './OrgSeamSections';

// Domain (accepted handoff §7 "Domain & SSO"): domain verification (live) and
// the identity-provider / SSO policy seam (no substrate yet — honest
// placeholder). Takes over ATS Settings' former Domain verification and
// Security & SSO pages.
export function DomainSection() {
  return (
    <SettingsSection
      title="Domain"
      description="Prove your organization controls its email domain, and review how people sign in. Verifying makes your organization the owner of its email domain on Aramo, and is required before starting a new self-service Aramo Sign plan."
    >
      <DomainVerificationPanel />
      <SsoSeam />
    </SettingsSection>
  );
}
