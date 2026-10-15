import { describe, expect, it } from 'vitest';

import {
  runIdentitySeed,
  SCREENING_SEED_BUNDLES,
  SCREENING_TRANSCRIPT_SEED_BUNDLES,
  SEED_IDS,
} from '../../prisma/seed.js';
import { PLATFORM_SCOPE_KEYS, SEED_SCOPE_KEYS } from '../lib/dto/index.js';

// TIP-E2E INC-3 (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §8; directive tests 6 + 41) —
// the screening:* role-matrix gate (unit tier).
//
// LOCKED matrix:
//   recruiter, lead_recruiter, recruiting_manager →
//     screening:{read,create,edit,confirm}
// Every other role — including tenant_admin, tenant_owner, org_admin,
// account_manager, delivery_manager, back_office, auditor,
// auditor_with_financials, sourcer, finance, esign_*, super_admin and the
// portal role — holds NO screening scope. No screening authority is inferred
// from administrative status (Architect D3-a).
//
// Two tiers of proof:
//   1. the dedicated SCREENING_SEED_BUNDLES grant table;
//   2. the EFFECTIVE grant set of the REAL runIdentitySeed, captured through a
//      recording fake Prisma client (the seed-scope-creation-parity precedent),
//      so a screening grant leaking through ANY other bundle fails here.

const SCREENING_SCOPES = [
  'screening:confirm',
  'screening:create',
  'screening:edit',
  'screening:read',
] as const;
const SCREENING_HOLDERS = ['lead_recruiter', 'recruiter', 'recruiting_manager'];
// INC-3 A1 (§B.7) — the transcript excerpt read scope, held by the same three
// roles; the full screening:* set each holder carries is therefore 5 scopes.
const TRANSCRIPT_SCOPE = 'screening:transcript:read';
const ALL_HELD = [...SCREENING_SCOPES, TRANSCRIPT_SCOPE].sort();

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

function screeningScopesOf(byRole: Map<string, Set<string>>, role: string): string[] {
  return [...(byRole.get(role) ?? [])].filter((s) => s.startsWith('screening:')).sort();
}

describe('screening:* role matrix — dedicated grant table (unit)', () => {
  it('grants to EXACTLY recruiter, lead_recruiter, recruiting_manager', () => {
    const roles = [...new Set(SCREENING_SEED_BUNDLES.map(([r]) => r))].sort();
    expect(roles).toEqual(SCREENING_HOLDERS);
  });

  it('each holder → exactly the 4 screening scopes (12 grants total)', () => {
    for (const role of SCREENING_HOLDERS) {
      const scopes = SCREENING_SEED_BUNDLES.filter(([r]) => r === role)
        .flatMap(([, s]) => s)
        .sort();
      expect(scopes, role).toEqual([...SCREENING_SCOPES]);
    }
    expect(SCREENING_SEED_BUNDLES.flatMap(([, s]) => s)).toHaveLength(12);
  });
});

describe('screening:* role matrix — effective seed grants (unit, directive tests 6 + 41)', () => {
  it('recruiter, lead_recruiter, recruiting_manager hold all 4 screening scopes plus transcript read (A1)', async () => {
    const { byRole } = await effectiveGrants();
    for (const role of SCREENING_HOLDERS) {
      expect(screeningScopesOf(byRole, role), role).toEqual(ALL_HELD);
    }
  });

  it('every other seeded role (incl. tenant_admin, tenant_owner, org_admin, super_admin) holds none', async () => {
    const { byRole } = await effectiveGrants();
    const others = Object.keys(SEED_IDS.roles).filter((r) => !SCREENING_HOLDERS.includes(r));
    // The named admin-tier and platform roles must be among the swept set.
    for (const named of ['tenant_admin', 'tenant_owner', 'org_admin', 'super_admin', 'account_manager']) {
      expect(others, named).toContain(named);
    }
    for (const role of others) {
      expect(screeningScopesOf(byRole, role), role).toEqual([]);
    }
  });

  it('exactly 12 screening RoleScope rows are seeded, with unique ids in 0x1700..0x170b', async () => {
    const { rows } = await effectiveGrants();
    const screeningScopeIds = new Set(SCREENING_SCOPES.map((k) => SEED_IDS.scopes[k] as string));
    const screeningRows = rows.filter((r) => screeningScopeIds.has(r.scope_id));
    expect(screeningRows).toHaveLength(12);
    const expectedIds = Array.from(
      { length: 12 },
      (_, i) => `01900000-0000-7000-8000-${(0x1700 + i).toString(16).padStart(12, '0')}`,
    );
    expect(screeningRows.map((r) => r.id).sort()).toEqual(expectedIds);
    // Collision-free across the WHOLE seeded RoleScope id space.
    const allIds = rows.map((r) => r.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});

describe('screening:* — scope-catalog parity (unit)', () => {
  it('SEED_SCOPE_KEYS contains each screening scope exactly once; none is platform-tier', () => {
    for (const key of SCREENING_SCOPES) {
      expect(SEED_SCOPE_KEYS.filter((k) => k === key), key).toHaveLength(1);
      expect((PLATFORM_SCOPE_KEYS as readonly string[]).includes(key), key).toBe(false);
    }
  });

  it('scope-node ids are 0x1405..0x1408 and collide with no other scope id', () => {
    expect(SCREENING_SCOPES.map((k) => SEED_IDS.scopes[k]).sort()).toEqual([
      '01900000-0000-7000-8000-000000001405',
      '01900000-0000-7000-8000-000000001406',
      '01900000-0000-7000-8000-000000001407',
      '01900000-0000-7000-8000-000000001408',
    ]);
    const all = Object.values(SEED_IDS.scopes);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('screening:transcript:read — INC-3 A1 §B.7 (unit)', () => {
  it('the dedicated bundle grants it to EXACTLY the three recruiter-tier roles (3 grants)', () => {
    expect(SCREENING_TRANSCRIPT_SEED_BUNDLES.map(([r]) => r).sort()).toEqual(SCREENING_HOLDERS);
    expect(SCREENING_TRANSCRIPT_SEED_BUNDLES.flatMap(([, s]) => s)).toEqual([TRANSCRIPT_SCOPE, TRANSCRIPT_SCOPE, TRANSCRIPT_SCOPE]);
  });

  it('exactly 3 rows are seeded with ids 0x1710..0x1712; scope node 0x1409; not platform-tier', async () => {
    const { rows } = await effectiveGrants();
    const id = SEED_IDS.scopes[TRANSCRIPT_SCOPE] as string;
    expect(id).toBe('01900000-0000-7000-8000-000000001409');
    const tRows = rows.filter((r) => r.scope_id === id);
    expect(tRows.map((r) => r.id).sort()).toEqual([
      '01900000-0000-7000-8000-000000001710',
      '01900000-0000-7000-8000-000000001711',
      '01900000-0000-7000-8000-000000001712',
    ]);
    expect(SEED_SCOPE_KEYS.filter((k) => k === TRANSCRIPT_SCOPE)).toHaveLength(1);
    expect((PLATFORM_SCOPE_KEYS as readonly string[]).includes(TRANSCRIPT_SCOPE)).toBe(false);
  });
});
