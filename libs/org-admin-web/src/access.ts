import type { Session } from '@aramo/fe-foundation';

// D-ORG-3 — the Organization Administration gate (§3.C/§3.E).
//
// Every /org/* section is reachable only by a principal holding an organization
// permission — the `tenant:admin:*` family (profile, domain, sites, user-manage,
// settings). The `core` capability (which lets ANY member mint an `org` session
// for the App Home) is deliberately NOT a gate here: core ≠ org_admin. The UI
// hide is UX; every admin API the sections call is `@RequireScopes(...)`-gated
// server-side, and the `org` consumer credential carries only the organization
// scope subset (ORG_ADMIN_SCOPE_KEYS) — never product or platform scopes.
export const ORG_ADMIN_SCOPE_PREFIX = 'tenant:admin:';

/** True when the session carries any `tenant:admin:*` organization scope. */
export function hasOrgAdminScope(session: Session): boolean {
  return session.scopes.some((scope) => scope.startsWith(ORG_ADMIN_SCOPE_PREFIX));
}
