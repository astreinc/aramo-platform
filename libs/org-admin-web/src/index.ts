// libs/org-admin-web — Aramo Organization Administration (D-ORG-3, §3.E; unified
// multi-product UX). The product-neutral organization administration surface:
// profile, users & invitations, users & product access, sites, domain, shared
// settings and audit. Served by apps/home-web at /org/* (the `org` consumer).
// Depends only on @aramo/fe-foundation (scope:shared) — no product lib.
export { OrgAdminRoutes, ORG_DENIED_NOTICE } from './OrgAdminRoutes';
export { OrgAdminShell } from './shell/OrgAdminShell';
export { ORG_SECTIONS, orgSectionLabel, orgSectionsFor, type OrgSection } from './sections';
export {
  hasOrgAdminScope,
  hasOrgTemplateScope,
  canEnterOrg,
  ORG_ADMIN_SCOPE_PREFIX,
  DOC_TEMPLATE_READ_SCOPE,
} from './access';
export { fetchMe, useMe, ME_PATH, type Me } from './me-api';
// Read-only roles reference — the ATS renders it as "ATS roles & permissions"
// (accepted change log A4): what each role can do, no assignment controls.
export { RolesMatrixView } from './roles/RolesMatrixView';
export { AuditLogView } from './audit/AuditLogView';
export type { RoleCatalogView } from './roles/roles-catalog-api';
