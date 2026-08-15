import { describe, expect, it } from 'vitest';

import { runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';

// T8-CONNECTOR-A — connector-management RBAC grant matrix (directive §23,
// Architect check #3). integration:read + integration:write are granted to
// tenant_admin + tenant_owner ONLY; every other role is DENIED. The connector
// ServiceAccount is a separate execution identity and holds NO management scope.

interface RoleScopeRow {
  id: string;
  role_id: string;
  scope_id: string;
}

function makeRecordingPrisma(rec: RoleScopeRow[]) {
  const modelProxy = (model: string): unknown =>
    new Proxy(
      {},
      {
        get:
          () =>
          (args?: { create?: Record<string, unknown> }): Promise<unknown> => {
            const c = args?.create;
            if (
              model === 'roleScope' &&
              c &&
              typeof c['id'] === 'string' &&
              typeof c['role_id'] === 'string' &&
              typeof c['scope_id'] === 'string'
            ) {
              rec.push({ id: c['id'], role_id: c['role_id'], scope_id: c['scope_id'] });
            }
            return Promise.resolve({});
          },
      },
    );
  return new Proxy({}, { get: (_t, p: string | symbol) => modelProxy(String(p)) }) as Parameters<
    typeof runIdentitySeed
  >[0];
}

const scopeIdToKey = new Map(Object.entries(SEED_IDS.scopes).map(([k, v]) => [v, k]));
const roleIdToKey = new Map(Object.entries(SEED_IDS.roles).map(([k, v]) => [v, k]));

async function grantingRolesFor(scopeKey: string): Promise<Set<string>> {
  const rec: RoleScopeRow[] = [];
  await runIdentitySeed(makeRecordingPrisma(rec), { includeDevFixtures: false });
  const scopeId = SEED_IDS.scopes[scopeKey as keyof typeof SEED_IDS.scopes];
  return new Set(
    rec
      .filter((r) => r.scope_id === scopeId)
      .map((r) => roleIdToKey.get(r.role_id) ?? r.role_id),
  );
}

describe('T8-CONNECTOR-A integration:* grant matrix', () => {
  const DENIED_ROLES = [
    'recruiter',
    'account_manager',
    'recruiting_manager',
    'lead_recruiter',
    'delivery_manager',
    'back_office',
  ];

  it('integration:read is granted to EXACTLY tenant_admin + tenant_owner', async () => {
    const roles = await grantingRolesFor('integration:read');
    expect([...roles].sort()).toEqual(['tenant_admin', 'tenant_owner']);
  });

  it('integration:write is granted to EXACTLY tenant_admin + tenant_owner', async () => {
    const roles = await grantingRolesFor('integration:write');
    expect([...roles].sort()).toEqual(['tenant_admin', 'tenant_owner']);
  });

  it('DENIES connector management to recruiter/account_manager/non-admin roles', async () => {
    const readRoles = await grantingRolesFor('integration:read');
    const writeRoles = await grantingRolesFor('integration:write');
    for (const role of DENIED_ROLES) {
      expect(readRoles.has(role), `${role} must NOT hold integration:read`).toBe(false);
      expect(writeRoles.has(role), `${role} must NOT hold integration:write`).toBe(false);
    }
  });

  it('the connector ServiceAccount id is distinct and holds NO role-scope grant', async () => {
    expect(SEED_IDS.service_account_connector).toBe('01900000-0000-7000-8000-000000000004');
    expect(SEED_IDS.service_account_connector).not.toBe(SEED_IDS.service_account_system);
    const rec: RoleScopeRow[] = [];
    await runIdentitySeed(makeRecordingPrisma(rec), { includeDevFixtures: false });
    // ServiceAccounts are not roles; no RoleScope row may reference the connector SA id.
    expect(rec.some((r) => r.role_id === SEED_IDS.service_account_connector)).toBe(false);
    // And the management scopes exist in the catalog (bijection sanity).
    expect(scopeIdToKey.get(SEED_IDS.scopes['integration:read'])).toBe('integration:read');
    expect(scopeIdToKey.get(SEED_IDS.scopes['integration:write'])).toBe('integration:write');
  });
});
