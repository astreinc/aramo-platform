// PLATFORM-UX-1 H-1 — the platform session and /platform/me fixtures (prototype
// PERSONAS). TEST-ONLY.

export const ALL_SCOPES = [
  'platform:tenant:read',
  'platform:tenant:provision',
  'platform:tenant:lifecycle:manage',
  'platform:admin:invite',
  'platform:skill:read',
  'platform:skill:manage',
  'platform:document_template:read',
  'platform:document_template:manage',
  'platform:matching_policy:read',
  'platform:matching_policy:write',
] as const;

/** The prototype's "Read-only auditor" persona (READP). */
export const READ_SCOPES = [
  'platform:tenant:read',
  'platform:skill:read',
  'platform:document_template:read',
  'platform:matching_policy:read',
] as const;

export const PLATFORM_TENANT_ID = 'tn_00ARAMOPLATFORM';

export type Persona = 'operator' | 'auditor' | 'tenantUser';

export const PERSONAS: Record<Persona, { sub: string; email: string; name: string; tenantId: string; tenant: string; roles: string[]; scopes: readonly string[] }> = {
  operator: { sub: 'usr_7f3a91c2e48b', email: 'maya.okafor@aramo.ai', name: 'Maya Okafor', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['super_admin'], scopes: ALL_SCOPES },
  auditor: { sub: 'usr_2b9d04e1c7aa', email: 'dev.raman@aramo.ai', name: 'Dev Raman', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['read_only_auditor'], scopes: READ_SCOPES },
  tenantUser: { sub: 'usr_91ac0d55e3f0', email: 'maya@northwind.com', name: 'Maya Okafor', tenantId: 'tn_01J8Q2NWX4', tenant: 'Northwind Logistics', roles: ['tenant_admin'], scopes: [] },
};

const IAT = Math.floor(Date.parse('2026-10-24T14:00:00Z') / 1000);

export function sessionBody(p: Persona) {
  const x = PERSONAS[p];
  return { sub: x.sub, consumer_type: 'platform', tenant_id: x.tenantId, scopes: [...x.scopes], iat: IAT, exp: IAT + 8 * 3600 };
}

export function meBody(p: Persona) {
  const x = PERSONAS[p];
  return { user_id: x.sub, email: x.email, display_name: x.name, tenant_id: x.tenantId, tenant_name: x.tenant, role_keys: x.roles };
}
