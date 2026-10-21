import { orgEntryHref } from '@aramo/fe-foundation';

import { SettingsSection } from '../components';

// DOC-TEMPLATE-LIB-1 T-4 (Implementation Directive v1.0 LOCKED §8.4; ADR-0034 D11) — the
// ATS Settings document-templates section is retired: template administration (the Aramo
// defaults, "Create your own document template", approval and the active template per
// document type) lives in Org Home. The ATS keeps only the "use" side (Send Right to
// Represent resolves the organization's active template). This page replaces the old
// screens (and their deep links) with one link into Org Home, through the org consumer's
// sign-in route so the SSO session carries over, with this page as the return context.
const ORG_SECTION = 'document-templates';

export function DocumentTemplatesMovedSection() {
  const here = typeof window === 'undefined' ? '' : `${window.location.pathname}${window.location.search}`;
  const href = orgEntryHref(ORG_SECTION, { app: 'ats', path: here });
  return (
    <SettingsSection
      title="Document templates"
      description="Document templates are managed for your whole organization in Org Home, shared by every Aramo product."
    >
      <p className="set-muted" data-testid="doc-templates-moved">
        Aramo defaults, your own templates, approvals and the template each document type uses are
        managed in Org Home. When a recruiter sends a Right to Represent, the ATS uses the template
        your organization chose there.
      </p>
      <p>
        <a href={href} className="rc-link-strong" data-testid="doc-templates-org-home-link">
          Manage templates in Org Home
        </a>
      </p>
    </SettingsSection>
  );
}
