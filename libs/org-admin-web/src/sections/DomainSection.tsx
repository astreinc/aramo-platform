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
      description="Prove your organization controls its email domain, and review how people sign in. Verification is a trust signal today; it does not change who can sign in or be invited."
    >
      <DomainVerificationPanel />
      <SsoSeam />
    </SettingsSection>
  );
}
