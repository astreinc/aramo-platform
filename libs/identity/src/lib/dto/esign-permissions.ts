// Aramo Sign permission contract (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.3, S-1). Aramo Sign owns its permissions;
// every Sign action is decided by sign-service against this contract.
//
// The `sign:` namespace is granted ONLY to the Sign product roles and — ROLES-1
// PR-2 (ADR-0035 R1) — the organization roles tenant_owner / tenant_admin; never to
// an ATS or platform role (PR-6 filters sign:* off non-sign consumers). Adding a key
// here requires a directive amendment, a SEED_SCOPE_KEYS entry, a seed grant and an
// orphan-scope classification.

export const ESIGN_SCOPE = {
  // Own envelopes (list, track, evidence). The gate of every workspace read.
  ENVELOPE_READ: 'sign:envelope:read',
  // Every envelope in the organization (BUSINESS tenants).
  ENVELOPE_READ_ALL: 'sign:envelope:read:all',
  // Draft authoring (documents, recipients, fields) on own drafts.
  ENVELOPE_CREATE: 'sign:envelope:create',
  // Send, remind and void own envelopes.
  ENVELOPE_SEND: 'sign:envelope:send',
  // Lifecycle and draft changes on ANY envelope in the organization.
  ENVELOPE_MANAGE_ALL: 'sign:envelope:manage:all',
  CONTACT_READ: 'sign:contact:read',
  // DOC-TEMPLATE-LIB-1 T-5 (§6.4; Conforming Amendment #7) — sign:template:use and
  // sign:template:manage are REMOVED: templates are Documents-owned and Sign uses
  // document_template:read (held by sign_admin, sign_sender and the organization roles).
  REPORT_READ: 'sign:report:read',
  // Assign and remove Sign roles for organization members.
  MEMBER_MANAGE: 'sign:member:manage',
  SETTINGS_MANAGE: 'sign:settings:manage',
  BILLING_MANAGE: 'sign:billing:manage',
  INTEGRATION_MANAGE: 'sign:integration:manage',
} as const;
export type EsignScope = (typeof ESIGN_SCOPE)[keyof typeof ESIGN_SCOPE];

// ROLES-1 PR-3 (Directive v1.0 LOCKED §1/§8; Conforming Amendments 4 and 6) — the Sign
// PRODUCT roles. `sign_owner` is RETIRED: Sign ownership and billing belong to the
// organization owner (tenant_owner); its row …02a0 stays in the database, inactive,
// for history only (never assignable, never granted, never projected).
export const ESIGN_ROLE_KEYS = ['sign_admin', 'sign_sender', 'sign_viewer'] as const;
export type EsignRoleKey = (typeof ESIGN_ROLE_KEYS)[number];

const S = ESIGN_SCOPE;
const ADMIN: readonly EsignScope[] = [
  S.ENVELOPE_READ, S.ENVELOPE_READ_ALL, S.ENVELOPE_CREATE, S.ENVELOPE_SEND, S.ENVELOPE_MANAGE_ALL,
  S.CONTACT_READ, S.REPORT_READ,
  S.MEMBER_MANAGE, S.SETTINGS_MANAGE, S.INTEGRATION_MANAGE,
];

// The complete, final permission set of each built-in Sign role (§4.3.4).
//   Admin  = everything except billing administration (billing — sign:billing:manage —
//            is held only by the organization owner, tenant_owner; ROLES-1 §3.4).
//   Sender = own envelopes (read, author, send, remind, void), contacts. (Template use is
//            document_template:read — DOC-TEMPLATE-LIB-1 T-5.)
//   Viewer = every organization envelope, read-only, and reports.
export const ESIGN_ROLE_PERMISSIONS: Readonly<Record<EsignRoleKey, readonly EsignScope[]>> = {
  sign_admin: ADMIN,
  sign_sender: [S.ENVELOPE_READ, S.ENVELOPE_CREATE, S.ENVELOPE_SEND, S.CONTACT_READ],
  sign_viewer: [S.ENVELOPE_READ, S.ENVELOPE_READ_ALL, S.REPORT_READ],
};

// Display names used by the Sign workspace's member administration.
export const ESIGN_ROLE_DISPLAY: Readonly<Record<EsignRoleKey, string>> = {
  sign_admin: 'Sign Admin',
  sign_sender: 'Sign Sender',
  sign_viewer: 'Sign Viewer',
};

export function isEsignRoleKey(k: string): k is EsignRoleKey {
  return (ESIGN_ROLE_KEYS as readonly string[]).includes(k);
}

// ROLES-1 PR-3 (§3.5) — the organization roles as the Sign workspace's member
// administration shows them. They are NOT Sign roles (Sign member administration
// never grants or removes them); their holders hold the Sign authority of their
// organization role (tenant_owner = everything incl. billing; tenant_admin =
// everything except billing — ADR-0035 R1). Names = the role catalog display names
// (the Role description's lead phrase), in precedence order.
export const SIGN_ORGANIZATION_ROLE_KEYS = ['tenant_owner', 'tenant_admin'] as const;
export type SignOrganizationRoleKey = (typeof SIGN_ORGANIZATION_ROLE_KEYS)[number];
export const SIGN_ORGANIZATION_ROLE_DISPLAY: Readonly<Record<SignOrganizationRoleKey, string>> = {
  tenant_owner: 'Tenant Owner',
  tenant_admin: 'Tenant Admin',
};
