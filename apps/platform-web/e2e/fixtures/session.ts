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

// CCP-B1 — the six commercial roles' bundles (CCP A1 §4.1; libs/identity/prisma/
// seed.ts CCP_PLATFORM_ROLE_SEED_BUNDLES), restated for the fixture (TD-A1-7).
// CCP-R3: CCP-A1 Amendment A1 grants platform:billing:amount:read to exactly platform_owner,
// finance_admin and read_only_auditor (FA-2). CCP-C8-PR: CCP-A1 Amendment A2 grants platform:payment:request to
// exactly commercial_ops and finance_admin (PS-2).
export const CCP_SCOPES = {
  platform_owner: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:approve', 'platform:catalog:publish', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', 'platform:billing:amount:read'],
  finance_admin: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:approve', 'platform:subscription:read', 'platform:subscription:approve', 'platform:entitlement:approve', 'platform:billing:read', 'platform:billing:approve', 'platform:approval:read', 'platform:commercial:audit:read', 'platform:billing:amount:read', 'platform:payment:request'],
  commercial_ops: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:request', 'platform:entitlement:request', 'platform:billing:read', 'platform:billing:request', 'platform:approval:read', 'platform:payment:request'],
  catalog_manager: ['platform:tenant:read', 'platform:catalog:read', 'platform:catalog:draft', 'platform:approval:read'],
  support_admin: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:subscription:support', 'platform:billing:read', 'platform:approval:read'],
  read_only_auditor: ['platform:tenant:read', 'platform:catalog:read', 'platform:subscription:read', 'platform:billing:read', 'platform:approval:read', 'platform:commercial:audit:read', 'platform:billing:amount:read'],
} as const;

/** CCP-B1 — the CCP prototype's people (ccp-data.js PEOPLE), one per commercial role. */
export type CcpPersona = 'ccpOwner' | 'ccpFinance' | 'ccpOps' | 'ccpCatalog' | 'ccpSupport' | 'ccpAuditor';

export type Persona = 'operator' | 'auditor' | 'tenantUser' | CcpPersona;

export const PERSONAS: Record<Persona, { sub: string; email: string; name: string; tenantId: string; tenant: string; roles: string[]; scopes: readonly string[] }> = {
  operator: { sub: 'usr_7f3a91c2e48b', email: 'maya.okafor@aramo.ai', name: 'Maya Okafor', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['super_admin'], scopes: ALL_SCOPES },
  auditor: { sub: 'usr_2b9d04e1c7aa', email: 'dev.raman@aramo.ai', name: 'Dev Raman', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['read_only_auditor'], scopes: READ_SCOPES },
  tenantUser: { sub: 'usr_91ac0d55e3f0', email: 'maya@northwind.com', name: 'Maya Okafor', tenantId: 'tn_01J8Q2NWX4', tenant: 'Northwind Logistics', roles: ['tenant_admin'], scopes: [] },
  ccpOwner: { sub: 'cc000000-0000-7000-8000-00000000da01', email: 'daniel.reyes@aramo.ai', name: 'Daniel Reyes', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['platform_owner'], scopes: CCP_SCOPES.platform_owner },
  ccpFinance: { sub: 'cc000000-0000-7000-8000-00000000a701', email: 'priya.shah@aramo.ai', name: 'Priya Shah', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['finance_admin'], scopes: CCP_SCOPES.finance_admin },
  ccpOps: { sub: 'cc000000-0000-7000-8000-00000000705a', email: 'tomas.silva@aramo.ai', name: 'Tomás Silva', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['commercial_ops'], scopes: CCP_SCOPES.commercial_ops },
  ccpCatalog: { sub: 'cc000000-0000-7000-8000-000000001e4a', email: 'lena.fischer@aramo.ai', name: 'Lena Fischer', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['catalog_manager'], scopes: CCP_SCOPES.catalog_manager },
  ccpSupport: { sub: 'cc000000-0000-7000-8000-00000000c3a1', email: 'kwame.mensah@aramo.ai', name: 'Kwame Mensah', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['support_admin'], scopes: CCP_SCOPES.support_admin },
  ccpAuditor: { sub: 'cc000000-0000-7000-8000-000000001e5d', email: 'ines.duarte@aramo.ai', name: 'Ines Duarte', tenantId: PLATFORM_TENANT_ID, tenant: 'Aramo Platform', roles: ['read_only_auditor'], scopes: CCP_SCOPES.read_only_auditor },
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
