// PLATFORM-UX-1 F-1 — the platform permissions (10) (handoff §2) with the plain
// labels the design shows next to the mono code (Platform Admin.dc.html PLABEL):
// the view-only note, the access-denied "Missing" row.

export const PLATFORM_PERMISSIONS = {
  tenantRead: 'platform:tenant:read',
  tenantProvision: 'platform:tenant:provision',
  tenantLifecycleManage: 'platform:tenant:lifecycle:manage',
  adminInvite: 'platform:admin:invite',
  skillRead: 'platform:skill:read',
  skillManage: 'platform:skill:manage',
  documentTemplateRead: 'platform:document_template:read',
  documentTemplateManage: 'platform:document_template:manage',
  matchingPolicyRead: 'platform:matching_policy:read',
  matchingPolicyWrite: 'platform:matching_policy:write',
} as const;

export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[keyof typeof PLATFORM_PERMISSIONS];

// CCP-B1 — the commercial read scopes the Commercial rail group filters on (CCP A1
// catalog, libs/identity/prisma/seed.ts CCP_PLATFORM_ROLE_SEED_BUNDLES). super_admin
// holds none of them (INV-1). The server stays authoritative on every route.
export const COMMERCIAL_PERMISSIONS = {
  approvalRead: 'platform:approval:read',
  subscriptionRead: 'platform:subscription:read',
  catalogRead: 'platform:catalog:read',
  // CCP-B2 — drafting plan versions (CCP A1 §4.1: catalog_manager). Merge train TD-MERGE-6:
  // B2's catalog pair folded into this one commercial map.
  catalogDraft: 'platform:catalog:draft',
  commercialAuditRead: 'platform:commercial:audit:read',
  // CCP-B6 — requesting a support extension or its removal (support_admin; merge train TD-MERGE-32).
  subscriptionSupport: 'platform:subscription:support',
} as const;

export type CommercialPermission = (typeof COMMERCIAL_PERMISSIONS)[keyof typeof COMMERCIAL_PERMISSIONS];

export const PERMISSION_LABEL: Readonly<Record<PlatformPermission | CommercialPermission, string>> = {
  'platform:tenant:read': 'View tenants',
  'platform:tenant:provision': 'Provision tenants',
  'platform:tenant:lifecycle:manage': 'Manage tenant lifecycle',
  'platform:admin:invite': 'Invite platform admins',
  'platform:skill:read': 'View skills',
  'platform:skill:manage': 'Manage skills',
  'platform:document_template:read': 'View templates',
  'platform:document_template:manage': 'Manage templates',
  'platform:matching_policy:read': 'View matching policy',
  'platform:matching_policy:write': 'Change matching policy',
  'platform:approval:read': 'View commercial change requests',
  'platform:subscription:read': 'View subscriptions',
  'platform:catalog:read': 'View the commercial catalog',
  'platform:commercial:audit:read': 'View the commercial audit',
  'platform:subscription:support': 'Request support extensions',
  'platform:catalog:draft': 'Draft plan versions',
};

/** The plain label for a permission code; an unknown code returns the code. */
export function permissionLabel(code: string): string {
  return (PERMISSION_LABEL as Readonly<Record<string, string>>)[code] ?? code;
}
