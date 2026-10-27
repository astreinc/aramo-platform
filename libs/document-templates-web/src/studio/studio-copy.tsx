import type { TemplateStudioCopy } from './data-source';
import { readinessLabel, type Readiness } from './readiness';
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

// ── TEMPLATE-STUDIO-1 S-1 — the organization context (handoff §2, §6, §8; directive §3) ──

/** Organization / Our templates / {name}. Template authors without organization
 * administration get the Organization crumb unlinked (they can't open Overview). */
export interface OrganizationStudioCopyOptions {
  /** The Organization crumb's link (null: plain text). */
  readonly organizationHref: string | null;
  /** Our templates (the list). */
  readonly listHref: string;
}

/** "{n} issues before approval" · "Ready to approve" (short below 1200px). */
export function organizationReadinessLabel(r: Readiness, wide: boolean): string {
  if (r.ready) return wide ? 'Ready to approve' : 'Ready';
  return `${r.fails}${r.fails === 1 ? ' issue' : ' issues'}${wide ? ' before approval' : ''}`;
}

export const ORGANIZATION_APPROVE_CONSEQUENCE = (next: number): string =>
  `v${next} becomes the template used for every future RTR. RTRs already sent stay pinned to the version they were sent with.`;

export const ORGANIZATION_VARIABLES_NOTE =
  'Fields come from Aramo’s governed catalog. Each one is bound to an authoritative source; you can’t add free-form variables.';

export const ORGANIZATION_SCOPE_CARD =
  'Organization default · used for every RTR your recruiters send from Aramo ATS. Client-specific templates may be supported later.';

export function organizationStudioCopy(o: OrganizationStudioCopyOptions): TemplateStudioCopy {
  return {
    crumbs: [o.organizationHref !== null ? { label: 'Organization', to: o.organizationHref } : { label: 'Organization' }, { label: 'Our templates', to: o.listHref }],
    back: { to: o.listHref, label: 'Back to Our templates' },
    approveButton: (next, wide) => (wide ? `Approve & activate v${next}…` : `Approve v${next}…`),
    approveHint: 'Approve & activate requires every check to pass',
    readinessLabel: organizationReadinessLabel,
    checksNote: 'Approve & activate unlocks when every required check passes. Saving the draft again resets the preview check.',
    approveDialog: {
      title: (next) => `Approve version v${next}?`,
      commit: (next) => `Approve & activate v${next}`,
      from: (current) => (current !== null ? { label: `v${current} active`, tone: 'ok' } : { label: 'No active version', tone: 'neutral' }),
      to: (next) => ({ label: `v${next} active`, tone: 'ok' }),
      consequence: (next) => ORGANIZATION_APPROVE_CONSEQUENCE(next),
    },
    approveToast: (n) => `v${n} is active. New RTRs use it from now on.`,
    approveFailed: 'Approval failed.',
    versionActive: { label: 'Active', tone: 'ok' },
    versionRetired: { label: 'Retired', tone: 'muted' },
    viewOnly: (
      <>
        <b>View only.</b> You&apos;re seeing the active version. Editing and draft preview need template authoring access.
      </>
    ),
    variablesNote: ORGANIZATION_VARIABLES_NOTE,
    scopeCard: ORGANIZATION_SCOPE_CARD,
    approveWarnings: (n) => `${n} warning${n > 1 ? 's' : ''} (inactive variables) will be approved as is.`,
    restoreToast: (n) => `Draft replaced with v${n}. Save and preview before approving.`,
    unknownVariableDetail: 'Not in Aramo’s governed catalog for this document type. Remove it from the draft.',
  };
}
