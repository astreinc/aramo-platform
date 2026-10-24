// PLATFORM-UX-1 F-1 — the 10 platform permissions (handoff §2) with the plain
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

export const PERMISSION_LABEL: Readonly<Record<PlatformPermission, string>> = {
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
};

/** The plain label for a permission code; an unknown code returns the code. */
export function permissionLabel(code: string): string {
  return (PERMISSION_LABEL as Readonly<Record<string, string>>)[code] ?? code;
}
