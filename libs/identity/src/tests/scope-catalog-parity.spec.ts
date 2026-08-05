import { describe, expect, it } from 'vitest';

import { SEED_SCOPE_KEYS } from '../lib/dto/scope.dto.js';
import { runIdentitySeed, SEED_IDS } from '../../prisma/seed.js';

// Track 3 / E2 — scope-catalog STRUCTURAL parity (CI guard). Complements
// seed-scope-creation-parity.spec.ts (which proves SEED_IDS.scopes ≡ upserted
// Scope rows). This spec proves the surrounding structure: the SEED_SCOPE_KEYS
// catalog ↔ SEED_IDS.scopes id-map relationship, key/id uniqueness, RoleScope
// bundle referential integrity, deterministic RoleScope-id uniqueness, and the
// PROTECTED zero-grant posture for the three named scopes.
//
// Counts are DERIVED, never hard-coded totals (a hard-coded total freezes the
// catalog and becomes noise people edit around). Both sides are captured
// PROGRAMMATICALLY: SEED_IDS / SEED_SCOPE_KEYS by import, the actual RoleScope
// grants by running the REAL runIdentitySeed against a recording Proxy (the
// seed-scope-creation-parity idiom — immune to call-site formatting).

// ---- capture the real seed's Scope / RoleScope creates -----------------------

type SeedPrisma = Parameters<typeof runIdentitySeed>[0];

interface RoleScopeRow {
  id: string;
  role_id: string;
  scope_id: string;
}
interface Recorded {
  scopes: string[]; // upserted Scope keys
  roleScopes: RoleScopeRow[]; // upserted RoleScope rows
}

function makeRecordingPrisma(rec: Recorded): SeedPrisma {
  const modelProxy = (model: string): unknown =>
    new Proxy(
      {},
      {
        get:
          () =>
          (args?: { create?: Record<string, unknown> }): Promise<unknown> => {
            const create = args?.create;
            if (create) {
              if (model === 'scope' && typeof create['key'] === 'string') {
                rec.scopes.push(create['key']);
              } else if (
                model === 'roleScope' &&
                typeof create['id'] === 'string' &&
                typeof create['role_id'] === 'string' &&
                typeof create['scope_id'] === 'string'
              ) {
                rec.roleScopes.push({ id: create['id'], role_id: create['role_id'], scope_id: create['scope_id'] });
              }
            }
            return Promise.resolve({});
          },
      },
    );
  return new Proxy(
    {},
    { get: (_t, prop: string | symbol) => modelProxy(String(prop)) },
  ) as SeedPrisma;
}

async function collect(): Promise<Recorded> {
  const rec: Recorded = { scopes: [], roleScopes: [] };
  await runIdentitySeed(makeRecordingPrisma(rec), { includeDevFixtures: false });
  return rec;
}

// ---- reference maps -----------------------------------------------------------

const declaredScopeKeys = Object.keys(SEED_IDS.scopes);
const scopeIdToKey = new Map(Object.entries(SEED_IDS.scopes).map(([k, v]) => [v, k]));
const roleIdToKey = new Map(Object.entries(SEED_IDS.roles).map(([k, v]) => [v, k]));

// The three scopes deliberately registered with ZERO default grants (§13c-1 /
// §13-R). A blocking waiver, restricted-evidence read, and reopen are granted
// only by a named human decision — never inherited from a bundle.
const PROTECTED_ZERO_GRANT_SCOPES = [
  'pre_start_requirement:waive_blocking',
  'pre_start_requirement:read_restricted_evidence',
  'pre_start_requirement:reopen',
] as const;

// F-2 CLOSED: platform:tenant:lifecycle:manage is now in SEED_SCOPE_KEYS, so the
// catalog and the id-map are a STRICT bijection — no exemption remains. Any NEW
// declared-id-without-a-catalog-key (or vice versa) now fails outright.

// ---- catalog ↔ id-map STRICT bijection ---------------------------------------

describe('scope catalog ↔ id-map', () => {
  it('every SEED_SCOPE_KEYS key has exactly one SEED_IDS.scopes entry', () => {
    const declared = new Set(declaredScopeKeys);
    const missing = SEED_SCOPE_KEYS.filter((k) => !declared.has(k));
    expect(missing, `catalog keys with no id: ${missing.join(', ')}`).toEqual([]);
  });

  it('no declared id without a catalog key (strict — no exemptions)', () => {
    const catalog = new Set<string>(SEED_SCOPE_KEYS);
    const dangling = declaredScopeKeys.filter((k) => !catalog.has(k));
    expect(dangling, `declared ids absent from the catalog: ${dangling.join(', ')}`).toEqual([]);
  });

  it('all scope keys are unique', () => {
    const dups = SEED_SCOPE_KEYS.filter((k, i) => SEED_SCOPE_KEYS.indexOf(k) !== i);
    expect(dups, `duplicate scope keys: ${[...new Set(dups)].join(', ')}`).toEqual([]);
  });

  it('all scope ids are unique', () => {
    const ids = Object.values(SEED_IDS.scopes);
    const dups = ids.filter((v, i) => ids.indexOf(v) !== i);
    const owners = dups.map((id) => scopeIdToKey.get(id));
    expect(dups, `duplicate scope ids owned by: ${owners.join(', ')}`).toEqual([]);
  });
});

// ---- declared ≡ created (self-contained, derived) ----------------------------

describe('scope declaration ≡ creation', () => {
  it('every declared scope is upserted (no RoleScope_scope_id_fkey gap)', async () => {
    const created = new Set((await collect()).scopes);
    const missing = declaredScopeKeys.filter((k) => !created.has(k));
    expect(missing, `declared but never upserted: ${missing.join(', ')}`).toEqual([]);
  });

  it('no upserted scope is undeclared', async () => {
    const declared = new Set(declaredScopeKeys);
    const extra = (await collect()).scopes.filter((k) => !declared.has(k));
    expect(extra, `upserted but undeclared: ${[...new Set(extra)].join(', ')}`).toEqual([]);
  });

  it('creates each scope exactly once', async () => {
    const scopes = (await collect()).scopes;
    const dups = scopes.filter((k, i) => scopes.indexOf(k) !== i);
    expect(dups, `duplicate scope upserts: ${[...new Set(dups)].join(', ')}`).toEqual([]);
  });
});

// ---- RoleScope bundle referential integrity ----------------------------------

describe('RoleScope bundle integrity', () => {
  it('every granted RoleScope references an existing role and a declared+created scope', async () => {
    const { scopes, roleScopes } = await collect();
    const created = new Set(scopes);
    const danglingRole: string[] = [];
    const danglingScope: string[] = [];
    const uncreatedScope: string[] = [];
    for (const rs of roleScopes) {
      const roleKey = roleIdToKey.get(rs.role_id);
      const scopeKey = scopeIdToKey.get(rs.scope_id);
      if (roleKey === undefined) danglingRole.push(rs.role_id);
      if (scopeKey === undefined) danglingScope.push(rs.scope_id);
      else if (!created.has(scopeKey)) uncreatedScope.push(scopeKey);
    }
    expect(danglingRole, `RoleScope role_id with no declared role: ${danglingRole.join(', ')}`).toEqual([]);
    expect(danglingScope, `RoleScope scope_id with no declared scope: ${danglingScope.join(', ')}`).toEqual([]);
    expect(uncreatedScope, `granted scope never created: ${uncreatedScope.join(', ')}`).toEqual([]);
  });

  it('deterministic RoleScope ids are unique', async () => {
    const ids = (await collect()).roleScopes.map((r) => r.id);
    const dups = ids.filter((v, i) => ids.indexOf(v) !== i);
    expect(dups, `duplicate RoleScope ids: ${[...new Set(dups)].join(', ')}`).toEqual([]);
  });
});

// ---- protected zero-grant posture (the narrow, named enforcement) ------------
// BOUNDARY: only these THREE scopes carry an exact-zero assertion. This is
// deliberately NOT generalised to "every ungranted scope stays ungranted" — a
// general rule would freeze the catalog and become noise. The narrowness IS the
// enforcement.

describe('protected zero-grant posture (§13c-1 / §13-R)', () => {
  it('the three protected scopes have EXACTLY zero RoleScope grants', async () => {
    const { roleScopes } = await collect();
    const violations: string[] = [];
    for (const scopeKey of PROTECTED_ZERO_GRANT_SCOPES) {
      const scopeId = SEED_IDS.scopes[scopeKey as keyof typeof SEED_IDS.scopes];
      for (const rs of roleScopes) {
        if (rs.scope_id === scopeId) {
          const roleKey = roleIdToKey.get(rs.role_id) ?? rs.role_id;
          violations.push(`${scopeKey} -> ${roleKey}`);
        }
      }
    }
    expect(
      violations,
      `Protected zero-grant scope unexpectedly granted:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});
