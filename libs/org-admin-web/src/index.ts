// libs/org-admin-web — Aramo Organization Administration (D-ORG-3, §3.E).
//
// The product-neutral organization administration surface, relocated from the
// ATS settings area: organization profile, sites & branches, domain verification,
// the user directory + invitations + membership + role assignment, the roles &
// permissions matrix, the audit log, and the organization-owned seams. Served
// by apps/home-web at /org/* on the tenant host (App Home); authenticated as the
// `org` consumer. Depends only on @aramo/fe-foundation (scope:shared) — no
// product lib, no ATS import (modularity preserved; ATS code is NOT merged into
// the App Home).
export { OrgAdminRoutes } from './OrgAdminRoutes';
export { OrgAdminShell, ORG_NAV } from './shell/OrgAdminShell';
export { hasOrgAdminScope, ORG_ADMIN_SCOPE_PREFIX } from './access';
export { fetchMe, useMe, ME_PATH, type Me } from './me-api';
