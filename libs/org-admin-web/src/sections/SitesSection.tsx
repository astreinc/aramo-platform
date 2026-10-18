import { SettingHint, SettingsSection } from '@aramo/fe-foundation';

import { SitesPanel } from '../sites/SitesPanel';

// D-ORG-3 — Sites & branches (full CRUD + hierarchy over the Site model;
// tenant:admin:sites). Relocated from ATS Settings → Branches & teams: sites are
// organization structure shared across products; TEAMS (recruiting pods) and
// the reporting hierarchy are ATS-owned and stayed in the ATS settings.
export function SitesSection() {
  return (
    <SettingsSection
      title="Sites & branches"
      description="The locations your organization operates from. Sites are shared by every Aramo product; product-specific teams are managed inside each product."
    >
      <SitesPanel />
      <SettingHint>
        Scoping flows organization → site → product teams. Recruiting teams (pods) are managed in the
        ATS under Settings → Teams &amp; organisation.
      </SettingHint>
    </SettingsSection>
  );
}
