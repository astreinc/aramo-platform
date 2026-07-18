import { describe, expect, it } from 'vitest';

import { runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';

// D-SEED-SCOPES-1 (GUARD) — structural creation-parity for the two RoleScope
// foreign-key parents. The F-P4b-1 defect shape, one layer down: a Scope (or
// Role) can be DECLARED in a SEED_IDS.* id-map and GRANTED to a role, yet never
// CREATED by an upsert* call — so the RoleScope insert dies mid-window on
// RoleScope_scope_id_fkey / RoleScope_role_id_fkey (P2003). That is exactly
// D-SEED-SCOPES-1: portal:{verification:read,dispute:read,dispute:write} were
// declared + granted but had no upsertScope call.
//
// Mirrors F-P4b-1's discipline — both sides derived PROGRAMMATICALLY, never
// hand-listed:
//   - declared side: Object.keys(SEED_IDS.scopes) / Object.keys(SEED_IDS.roles).
//   - created  side: the keys the seed ACTUALLY upserts, captured by running
//     the REAL runIdentitySeed against a fake Prisma client that records every
//     scope/role create.
//
// Running the real seed (not parsing source) means the guard tracks true
// runtime behavior and is immune to call-site formatting. The fake is a Proxy:
// any model.method() resolves; scope/role creates are recorded. runIdentitySeed
// consumes no DB reads (verified: all writes are fire-and-forget upserts), so a
// resolve-everything fake drives it end-to-end without stubbing return shapes.

type SeedPrisma = Parameters<typeof runIdentitySeed>[0];

interface Recorded {
  scopes: string[];
  roles: string[];
}

function makeRecordingPrisma(rec: Recorded): SeedPrisma {
  const modelProxy = (model: string): unknown =>
    new Proxy(
      {},
      {
        get:
          () =>
          (args?: { create?: { key?: string } }): Promise<unknown> => {
            const key = args?.create?.key;
            if (typeof key === 'string') {
              if (model === 'scope') rec.scopes.push(key);
              else if (model === 'role') rec.roles.push(key);
            }
            return Promise.resolve({});
          },
      },
    );

  return new Proxy(
    {},
    {
      get: (_target, prop: string | symbol) => modelProxy(String(prop)),
    },
  ) as SeedPrisma;
}

async function collectCreated(): Promise<Recorded> {
  const rec: Recorded = { scopes: [], roles: [] };
  await runIdentitySeed(makeRecordingPrisma(rec), { includeDevFixtures: false });
  return rec;
}

describe('D-SEED-SCOPES-1 — SEED_IDS.scopes ≡ upserted Scope rows', () => {
  it('every declared scope is actually created (no RoleScope_scope_id_fkey gap)', async () => {
    const { scopes } = await collectCreated();
    const created = new Set(scopes);
    const missing = Object.keys(SEED_IDS.scopes).filter((k) => !created.has(k));
    expect(missing).toEqual([]); // a declared-but-uncreated scope = the D-SEED-SCOPES-1 bug
  });

  it('no upserted scope is undeclared (no dangling create)', async () => {
    const { scopes } = await collectCreated();
    const declared = new Set(Object.keys(SEED_IDS.scopes));
    const extra = scopes.filter((k) => !declared.has(k));
    expect(extra).toEqual([]);
  });

  it('creates each scope exactly once (no duplicate upsert)', async () => {
    const { scopes } = await collectCreated();
    expect(scopes.length).toBe(new Set(scopes).size);
  });
});

describe('D-SEED-SCOPES-1 — SEED_IDS.roles ≡ upserted Role rows (adjacent FK parent)', () => {
  it('every declared role is actually created (no RoleScope_role_id_fkey gap)', async () => {
    const { roles } = await collectCreated();
    const created = new Set(roles);
    const missing = Object.keys(SEED_IDS.roles).filter((k) => !created.has(k));
    expect(missing).toEqual([]);
  });

  it('no upserted role is undeclared', async () => {
    const { roles } = await collectCreated();
    const declared = new Set(Object.keys(SEED_IDS.roles));
    const extra = roles.filter((k) => !declared.has(k));
    expect(extra).toEqual([]);
  });
});
