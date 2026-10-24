// PLATFORM-UX-1 F-5 (handoff §6.3 People) — the role chips of the tenant user
// invite. The keys mirror the backend allow-list of
// POST /platform/tenants/:id/invitations (InviteUserRequestDto →
// libs/identity TENANT_ASSIGNABLE_ROLE_KEYS: the seed catalog minus the
// platform-tier super_admin), in the role-catalog tier order. The labels are
// the seed descriptions' leading phrase in sentence case. The backend stays the
// authority: a refused combination comes back as VALIDATION_ERROR and its
// message is shown as written (amendment 4).
//
// One tenant-assignable key is deliberately not offered: the talent-portal
// subject role. It is not a staff role an operator invites, and its key is a
// banned word under scripts/verify-vocabulary.sh (TIER2_TERMS_REGEX), so it
// cannot be written in platform-web source.

export interface TenantRoleOption {
  readonly key: string;
  readonly label: string;
  /** The tooltip / note (the Owner chip's design note). */
  readonly note?: string;
  /** Not grantable from the console. */
  readonly disabled?: boolean;
}

export const TENANT_INVITE_ROLES: readonly TenantRoleOption[] = [
  { key: 'tenant_owner', label: 'Owner', note: 'Only an existing owner can grant this.', disabled: true },
  { key: 'tenant_admin', label: 'Tenant admin', note: 'Users, sites and organization settings.' },
  { key: 'ats_admin', label: 'ATS admin', note: 'ATS configuration.' },
  { key: 'account_manager', label: 'Account manager' },
  { key: 'recruiting_manager', label: 'Recruiting manager' },
  { key: 'delivery_manager', label: 'Delivery manager' },
  { key: 'lead_recruiter', label: 'Lead recruiter' },
  { key: 'recruiter', label: 'Recruiter' },
  { key: 'sourcer', label: 'Sourcer' },
  { key: 'back_office', label: 'Back office' },
  { key: 'finance', label: 'Finance' },
  { key: 'auditor', label: 'Auditor' },
  { key: 'auditor_with_financials', label: 'Auditor with financials' },
  { key: 'sign_admin', label: 'Sign admin', note: 'Sign configuration.' },
  { key: 'sign_sender', label: 'Sign sender' },
  { key: 'sign_viewer', label: 'Sign viewer' },
];

/** The design's default selection. */
export const DEFAULT_INVITE_ROLES: readonly string[] = ['tenant_admin'];
