// CCP-B6 — the scopes the support-extension screen gates on (CCP A1 §4.1; libs/identity
// scripts/scope-catalog-consistency.mjs CCP_EXPECTED). The server stays authoritative on every
// route. At merge these fold into B1's COMMERCIAL_PERMISSIONS (components/permissions.ts).
export const SUPPORT_SCOPES = {
  /** The route gate and GET /support-extensions (5 commercial roles; never super_admin or catalog_manager). */
  subscriptionRead: 'platform:subscription:read',
  /** POST /support-extensions and the removal request (support_admin only). */
  support: 'platform:subscription:support',
  /** The change-request reads (the open escalation or removal) — all 6 commercial roles. */
  approvalRead: 'platform:approval:read',
} as const;
