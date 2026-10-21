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

// DOC-TEMPLATE-LIB-1 T-4 (§6.2, §8.2) — the Org Home "Document templates" section is gated
// by document_template:read (manage actions by document_template:manage), which the org
// session now carries. A holder of the read scope alone (e.g. a recruiter opening Org Home)
// reaches ONLY that section; every other section still needs a `tenant:admin:*` scope.
export const DOC_TEMPLATE_READ_SCOPE = 'document_template:read';

/** True when the session may open the Org Home document-templates section. */
export function hasOrgTemplateScope(session: Session): boolean {
  return session.scopes.includes(DOC_TEMPLATE_READ_SCOPE);
}

/** True when the session may enter /org/* at all (any section it can see). */
export function canEnterOrg(session: Session): boolean {
  return hasOrgAdminScope(session) || hasOrgTemplateScope(session);
}
