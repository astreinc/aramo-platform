// Aramo Sign permission contract (Aramo-Sign-Unified-Product-Permission-Contract-
// Platform-API-Directive-v1_0-LOCKED §4.3, S-1). Aramo Sign owns its permissions;
// every Sign action is decided by sign-service against this contract.
//
// The `sign:` namespace is granted ONLY to the four esign_* roles — never to an
// ATS, organization or platform role (PR-6 filters esign:* off non-esign
// consumers). Adding a key here requires a directive amendment, a SEED_SCOPE_KEYS
// entry, a seed grant and an orphan-scope classification.

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
  TEMPLATE_USE: 'sign:template:use',
  TEMPLATE_MANAGE: 'sign:template:manage',
  REPORT_READ: 'sign:report:read',
  // Assign and remove Sign roles for organization members.
  MEMBER_MANAGE: 'sign:member:manage',
  SETTINGS_MANAGE: 'sign:settings:manage',
  BILLING_MANAGE: 'sign:billing:manage',
  INTEGRATION_MANAGE: 'sign:integration:manage',
} as const;
export type EsignScope = (typeof ESIGN_SCOPE)[keyof typeof ESIGN_SCOPE];

export const ESIGN_ROLE_KEYS = ['sign_owner', 'sign_admin', 'sign_sender', 'sign_viewer'] as const;
export type EsignRoleKey = (typeof ESIGN_ROLE_KEYS)[number];

const S = ESIGN_SCOPE;
const ADMIN: readonly EsignScope[] = [
  S.ENVELOPE_READ, S.ENVELOPE_READ_ALL, S.ENVELOPE_CREATE, S.ENVELOPE_SEND, S.ENVELOPE_MANAGE_ALL,
  S.CONTACT_READ, S.TEMPLATE_USE, S.TEMPLATE_MANAGE, S.REPORT_READ,
  S.MEMBER_MANAGE, S.SETTINGS_MANAGE, S.INTEGRATION_MANAGE,
];

// The complete, final permission set of each built-in Sign role (§4.3.4).
//   Owner  = everything, including billing administration.
//   Admin  = everything except billing administration.
//   Sender = own envelopes (read, author, send, remind, void), contacts, template use.
//   Viewer = every organization envelope, read-only, and reports.
export const ESIGN_ROLE_PERMISSIONS: Readonly<Record<EsignRoleKey, readonly EsignScope[]>> = {
  sign_owner: [...ADMIN, S.BILLING_MANAGE],
  sign_admin: ADMIN,
  sign_sender: [S.ENVELOPE_READ, S.ENVELOPE_CREATE, S.ENVELOPE_SEND, S.CONTACT_READ, S.TEMPLATE_USE],
  sign_viewer: [S.ENVELOPE_READ, S.ENVELOPE_READ_ALL, S.REPORT_READ],
};

// Display names used by the Sign workspace's member administration.
export const ESIGN_ROLE_DISPLAY: Readonly<Record<EsignRoleKey, string>> = {
  sign_owner: 'Sign Owner',
  sign_admin: 'Sign Admin',
  sign_sender: 'Sign Sender',
  sign_viewer: 'Sign Viewer',
};

export function isEsignRoleKey(k: string): k is EsignRoleKey {
  return (ESIGN_ROLE_KEYS as readonly string[]).includes(k);
}
