import type { TemplateStudioCopy } from './data-source';
import { readinessLabel } from './readiness';
import { publishConsequence } from './studio-dialogs';

// TEMPLATE-STUDIO-1 S-0 — the platform context's copy table (PLATFORM-UX-1 F-9, handoff
// §10): Publish vN, the platform-default consequence, the console crumbs and the Template
// variables link. The organization table (Approve & activate) comes with S-1.

export const PLATFORM_STUDIO_COPY: TemplateStudioCopy = {
  crumbs: [{ label: 'Documents' }, { label: 'Document templates', to: '/document-templates' }],
  back: { to: '/document-templates', label: 'Back to templates' },
  // Three text runs, as the original top bar rendered them (identical text shaping).
  approveButton: (next) => (
    <>
      Publish {`v${next}`}…
    </>
  ),
  approveHint: 'Publish requires every check to pass',
  readinessLabel,
  checksNote: 'Publish unlocks when every required check passes. Saving the draft again resets the preview check.',
  approveDialog: {
    title: (next, name) => `Publish v${next} of ${name}`,
    commit: (next) => `Publish v${next}`,
    from: (current) => (current !== null ? { label: `v${current} published`, tone: 'ok' } : { label: 'Not published', tone: 'neutral' }),
    to: (next) => ({ label: `v${next} published`, tone: 'ok' }),
    consequence: publishConsequence,
  },
  approveToast: (n) => `v${n} published. Tenants now get this version.`,
  approveFailed: 'Publish failed.',
  versionActive: { label: 'Published', tone: 'ok' },
  versionRetired: { label: 'Replaced', tone: 'muted' },
  viewOnly: (
    <>
      <b>View only.</b> You&apos;re seeing the published version. Editing and draft preview need the <b>Manage templates</b> permission.
    </>
  ),
  manageVariables: { to: '/template-variables', label: 'Manage template variables ↗' },
};
