import { describe, expect, it } from 'vitest';

import { PIPELINE_RE_ADD_SEED_BUNDLES, runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';
import { SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// Pipeline & RTR Recon Remediation Directive v1.0 LOCKED §2 R3 (DEF-15(b); PO ruling 2026-10-21) —
// the pipeline:re-add role matrix. Re-adding a Talent whose episode on a requisition ENDED is
// permitted ONLY to a Recruiter Lead, Recruiting Manager, Tenant Admin or Tenant Owner — never to a
// recruiter, sourcer or any other role. Two tiers of proof (the screening-role-matrix precedent):
//   1. the dedicated PIPELINE_RE_ADD_SEED_BUNDLES grant table;
//   2. the EFFECTIVE grant set of the REAL runIdentitySeed through a recording fake Prisma client,
//      so a grant leaking through ANY other bundle fails here.

const SCOPE = 'pipeline:re-add';
// ROLES-1 reconciliation: the PO's "Tenant Admin" (row …0010) is now `ats_admin`; the
// ORGANIZATION `tenant_admin` (row …02b0) inherits every ats_admin scope (ROLES1_ATS_GRANT_SOURCES).
const BUNDLE_ROLES = ['ats_admin', 'lead_recruiter', 'recruiting_manager', 'tenant_owner'];
const HOLDERS = ['ats_admin', 'lead_recruiter', 'recruiting_manager', 'tenant_admin', 'tenant_owner'];

type SeedPrisma = Parameters<typeof runIdentitySeed>[0];

interface RoleScopeRow {
  id: string;
  role_id: string;
  scope_id: string;
}

function makeRecordingPrisma(rows: RoleScopeRow[]): SeedPrisma {
  const modelProxy = (model: string): unknown =>
    new Proxy(
      {},
      {
        get:
          () =>
          (args?: { create?: Partial<RoleScopeRow> }): Promise<unknown> => {
            const c = args?.create;
            if (
              model === 'roleScope' &&
              typeof c?.id === 'string' &&
              typeof c.role_id === 'string' &&
              typeof c.scope_id === 'string'
            ) {
              rows.push({ id: c.id, role_id: c.role_id, scope_id: c.scope_id });
            }
            return Promise.resolve({});
          },
      },
    );
  return new Proxy(
    {},
    { get: (_target, prop: string | symbol) => modelProxy(String(prop)) },
  ) as SeedPrisma;
}

async function effectiveGrants(): Promise<{ rows: RoleScopeRow[]; byRole: Map<string, Set<string>> }> {
  const rows: RoleScopeRow[] = [];
  await runIdentitySeed(makeRecordingPrisma(rows), { includeDevFixtures: false });
  const roleKeyById = new Map(Object.entries(SEED_IDS.roles).map(([k, v]) => [v as string, k]));
  const scopeKeyById = new Map(Object.entries(SEED_IDS.scopes).map(([k, v]) => [v as string, k]));
  const byRole = new Map<string, Set<string>>();
  for (const r of rows) {
    const role = roleKeyById.get(r.role_id) ?? r.role_id;
    const scope = scopeKeyById.get(r.scope_id) ?? r.scope_id;
    if (!byRole.has(role)) byRole.set(role, new Set());
    byRole.get(role)?.add(scope);
  }
  return { rows, byRole };
}

describe('pipeline:re-add role matrix (Remediation v1.0 R3, DEF-15(b))', () => {
  it('the scope is in the catalog exactly once', () => {
    expect(SEED_SCOPE_KEYS.filter((k) => k === SCOPE)).toHaveLength(1);
  });

  it('the dedicated grant table names EXACTLY the 4 senior roles (4 grants)', () => {
    expect([...new Set(PIPELINE_RE_ADD_SEED_BUNDLES.map(([r]) => r))].sort()).toEqual(BUNDLE_ROLES);
    expect(PIPELINE_RE_ADD_SEED_BUNDLES.flatMap(([, s]) => s)).toEqual([SCOPE, SCOPE, SCOPE, SCOPE]);
  });

  it('the REAL seed grants pipeline:re-add to the senior roles (+ the organization tenant_admin, derived) — never a recruiter or sourcer', async () => {
    const { rows, byRole } = await effectiveGrants();
    const holders = [...byRole.entries()].filter(([, scopes]) => scopes.has(SCOPE)).map(([role]) => role).sort();
    expect(holders).toEqual(HOLDERS);
    for (const notHolder of ['recruiter', 'sourcer', 'account_manager', 'delivery_manager', 'back_office', 'auditor']) {
      expect(byRole.get(notHolder)?.has(SCOPE) ?? false, notHolder).toBe(false);
    }
    // RoleScope ids stay unique across the whole seed.
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
});
