// libs/org-admin-web — Aramo Organization Administration (D-ORG-3, §3.E; unified
// multi-product UX). The product-neutral organization administration surface:
// profile, users & invitations, users & product access, sites, domain, shared
// settings and audit. Served by apps/home-web at /org/* (the `org` consumer).
// Depends on @aramo/fe-foundation and @aramo/document-templates-web (both scope:shared).
export { OrgAdminRoutes, ORG_DENIED_NOTICE } from './OrgAdminRoutes';
export { OrgAdminShell } from './shell/OrgAdminShell';
export {
  ORG_SECTIONS,
  ORG_SECTION_INTRO,
  SHARED_SETUP_HEADING,
  ORGANIZATION_HEADING,
  orgSectionLabel,
  orgSectionsFor,
  orgSectionByKey,
  orgSectionForPath,
  isOrgStudioPath,
  type OrgSection,
  type OrgSectionKey,
  type OrgAccessTier,
} from './sections';
export { useOrgAccess, canApproveTemplates, canAuthorTemplates, type OrgAccessState } from './access';
export { OrgPageHeader, OrgModal, OrgCheck, OrgAvatar } from './ui/OrgPage';
export { useSetupChecklist, type SetupItem, type SetupItemKey, type SetupChecklistState } from './overview/setup-checklist';
export { InviteUserModal, type InviteUserModalProps } from './users/InviteUserModal';
export { fetchMe, useMe, ME_PATH, type Me } from './me-api';
// Read-only roles reference — the ATS renders it as "ATS roles & permissions"
// (accepted change log A4): what each role can do, no assignment controls.
export { RolesMatrixView } from './roles/RolesMatrixView';
export { AuditLogView } from './audit/AuditLogView';
export type { RoleCatalogView } from './roles/roles-catalog-api';
// TEMPLATE-STUDIO-1 S-1 — the Organization host of the shared Template Studio (token map
// studio-theme.css, compact nav, account slot, error formatter) and the tenant-template
// Studio route, reusable by every Org Studio route (S-2: the Aramo-default preview).
export { OrgStudioHost, orgStudioErrorMessage, useOrgStudioAccount } from './document-templates/OrgStudioHost';
export { OrgTemplateStudio, type OrgTemplateStudioProps } from './document-templates/OrgTemplateStudio';
