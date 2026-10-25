import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  CCP_A1_ROLE_DESCRIPTIONS,
  CCP_A1_SCOPE_DESCRIPTIONS,
  CCP_PLATFORM_ROLE_SEED_BUNDLES,
  ROLES1_ATS_ADMIN_SCOPES,
  SEED_IDS,
  ccpA1RoleScopeId,
  runIdentitySeed,
} from '../../prisma/seed.js';
import { filterScopesForConsumer } from '../lib/authorization/consumer-scope-policy.js';
import {
  ATS_PRODUCT_ROLE_KEYS,
  ESIGN_PRODUCT_ROLE_KEYS,
  ORG_ROLE_KEYS,
  PLATFORM_ROLE_KEYS,
  SEED_ROLE_KEYS,
  TENANT_ASSIGNABLE_ROLE_KEYS,
} from '../lib/dto/role.dto.js';
import { PLATFORM_SCOPE_KEYS, SCOPE_KEY_FORMAT, SEED_SCOPE_KEYS } from '../lib/dto/scope.dto.js';
import { RoleCatalogService } from '../lib/role-catalog/role-catalog.service.js';

// CCP A1 — Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0 (LOCKED), the binding
// execution schedule under Aramo-CCP-Program-Build-Directive-v1_0 (LOCKED). Proves, against
// the seed exactly as every fresh database is built (a recording Prisma, no database):
//   §4.1 matrix exact (ruling A0-C4); INV-1…INV-4 (§4.3); the §5 partitions and totals;
//   §6.3.4 (the CCP bundle is not an ATS grant source); §6.8 descriptions; §7.1 partitions;
//   §7.3(d) tenant role catalog; §7.3(e) consumer filter; §8 reused-identity pair report;
//   §10.2 regression (pre-A1 rows byte-identical, by fingerprint taken at 78dbd6d3).

const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
type CcpRole = (typeof CCP_ROLES)[number];
const COMMERCIAL = [
  'platform:catalog:read',
  'platform:catalog:draft',
  'platform:catalog:approve',
  'platform:catalog:publish',
  'platform:subscription:read',
  'platform:subscription:request',
  'platform:subscription:approve',
  'platform:subscription:support',
  'platform:entitlement:request',
  'platform:entitlement:approve',
  'platform:billing:read',
  'platform:billing:request',
  'platform:billing:approve',
  'platform:approval:read',
  'platform:commercial:audit:read',
] as const;
const ENTRY = 'platform:tenant:read';

// §4.1, transcribed column by column (● = granted). Order: PO FA CO CM SA RA.
const MATRIX: Record<(typeof COMMERCIAL)[number] | typeof ENTRY, readonly [0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1, 0 | 1]> = {
  'platform:tenant:read': [1, 1, 1, 1, 1, 1],
  'platform:catalog:read': [1, 1, 1, 1, 1, 1],
  'platform:catalog:draft': [0, 0, 0, 1, 0, 0],
  'platform:catalog:approve': [1, 1, 0, 0, 0, 0],
  'platform:catalog:publish': [1, 0, 0, 0, 0, 0],
  'platform:subscription:read': [1, 1, 1, 0, 1, 1],
  'platform:subscription:request': [0, 0, 1, 0, 0, 0],
  'platform:subscription:approve': [1, 1, 0, 0, 0, 0],
  'platform:subscription:support': [0, 0, 0, 0, 1, 0],
  'platform:entitlement:request': [0, 0, 1, 0, 0, 0],
  'platform:entitlement:approve': [1, 1, 0, 0, 0, 0],
  'platform:billing:read': [1, 1, 1, 0, 1, 1],
  'platform:billing:request': [0, 0, 1, 0, 0, 0],
  'platform:billing:approve': [1, 1, 0, 0, 0, 0],
  'platform:approval:read': [1, 1, 1, 1, 1, 1],
  'platform:commercial:audit:read': [1, 1, 0, 0, 0, 1],
};
const expectedBundle = (role: CcpRole): string[] =>
  Object.entries(MATRIX)
    .filter(([, row]) => row[CCP_ROLES.indexOf(role)] === 1)
    .map(([k]) => k)
    .sort();

// INV-2 — initiating vs deciding scopes per domain.
const DOMAINS = {
  catalog: { initiate: ['platform:catalog:draft'], decide: ['platform:catalog:approve', 'platform:catalog:publish'] },
  subscription: { initiate: ['platform:subscription:request', 'platform:subscription:support'], decide: ['platform:subscription:approve'] },
  entitlement: { initiate: ['platform:entitlement:request'], decide: ['platform:entitlement:approve'] },
  billing: { initiate: ['platform:billing:request'], decide: ['platform:billing:approve'] },
} as const;
const makerCheckerOverlap = (scopes: ReadonlySet<string>): string[] =>
  Object.entries(DOMAINS)
    .filter(([, d]) => d.initiate.some((s) => scopes.has(s)) && d.decide.some((s) => scopes.has(s)))
    .map(([name]) => name);

const SUPER_ADMIN_BUNDLE = [
  'platform:admin:invite',
  'platform:document_template:manage',
  'platform:document_template:read',
  'platform:matching_policy:read',
  'platform:matching_policy:write',
  'platform:skill:manage',
  'platform:skill:read',
  'platform:tenant:lifecycle:manage',
  'platform:tenant:provision',
  'platform:tenant:read',
];

// ── A recording Prisma: the seed's create payloads, no database. ─────────────────────────
type Row = Record<string, unknown>;
interface Recorded {
  roleScopes: { id: string; role_id: string; scope_id: string }[];
  roles: Row[];
  scopes: Row[];
  membershipRoles: Row[];
}
function makeRecordingPrisma(rec: Recorded) {
  const modelProxy = (model: string): unknown =>
    new Proxy(
      {},
      {
        get:
          () =>
          (args?: { create?: Row }): Promise<unknown> => {
            const c = args?.create;
            if (c !== undefined) {
              if (model === 'roleScope') rec.roleScopes.push(c as Recorded['roleScopes'][number]);
              if (model === 'role') rec.roles.push(c);
              if (model === 'scope') rec.scopes.push(c);
              if (model === 'userTenantMembershipRole') rec.membershipRoles.push(c);
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
async function seeded(includeDevFixtures = false) {
  const rec: Recorded = { roleScopes: [], roles: [], scopes: [], membershipRoles: [] };
  await runIdentitySeed(makeRecordingPrisma(rec), { includeDevFixtures });
  const unique = new Map<string, Recorded['roleScopes'][number]>();
  for (const r of rec.roleScopes) unique.set(`${r.role_id}:${r.scope_id}`, r);
  const bundles = new Map<string, Set<string>>();
  for (const r of unique.values()) {
    const role = roleIdToKey.get(r.role_id) ?? r.role_id;
    if (!bundles.has(role)) bundles.set(role, new Set());
    bundles.get(role)?.add(scopeIdToKey.get(r.scope_id) ?? r.scope_id);
  }
  return { ...rec, unique, bundles };
}
const sha = (lines: string[]): string => createHash('sha256').update([...lines].sort().join('\n')).digest('hex');
const ccpRoleIds = new Set(CCP_ROLES.map((k) => SEED_IDS.roles[k]));

describe('CCP A1 §4.1 — the approved role × scope matrix (ruling A0-C4)', () => {
  it('CCP_PLATFORM_ROLE_SEED_BUNDLES equals the §4.1 matrix exactly, role by role', () => {
    expect(CCP_PLATFORM_ROLE_SEED_BUNDLES.map(([r]) => r)).toEqual([...CCP_ROLES]);
    for (const [role, scopes] of CCP_PLATFORM_ROLE_SEED_BUNDLES) {
      expect(new Set(scopes).size, role).toBe(scopes.length);
      expect([...scopes].sort(), role).toEqual(expectedBundle(role as CcpRole));
    }
  });

  it('the seed grants exactly that matrix — bundle sizes 11 / 10 / 8 / 4 / 6 / 6, 45 rows, 39 commercial', async () => {
    const { bundles } = await seeded();
    const sizes = CCP_ROLES.map((r) => bundles.get(r)?.size);
    expect(sizes).toEqual([11, 10, 8, 4, 6, 6]);
    for (const role of CCP_ROLES) expect([...(bundles.get(role) ?? [])].sort(), role).toEqual(expectedBundle(role));
    const commercialHeld = CCP_ROLES.map((r) => [...(bundles.get(r) ?? [])].filter((s) => s !== ENTRY).length);
    expect(commercialHeld).toEqual([10, 9, 7, 3, 5, 5]);
    expect(commercialHeld.reduce((a, b) => a + b, 0)).toBe(39);
    expect(sizes.reduce((a, b) => (a ?? 0) + (b ?? 0), 0)).toBe(45);
  });

  it('holders per commercial scope match §4.1 (total 39); every commercial scope has at least 1 holder', async () => {
    const { bundles } = await seeded();
    const holders = (s: string) => CCP_ROLES.filter((r) => bundles.get(r)?.has(s)).length;
    expect(COMMERCIAL.map(holders)).toEqual([6, 1, 2, 1, 5, 1, 2, 1, 1, 2, 5, 1, 2, 6, 3]);
    expect(COMMERCIAL.map(holders).reduce((a, b) => a + b, 0)).toBe(39);
    for (const s of COMMERCIAL) expect(holders(s), s).toBeGreaterThanOrEqual(1);
  });

  it('every CCP RoleScope row carries the migration-identical md5 id (ccpA1RoleScopeId)', async () => {
    const { unique } = await seeded();
    const rows = [...unique.values()].filter((r) => ccpRoleIds.has(r.role_id));
    expect(rows).toHaveLength(45);
    for (const r of rows) {
      expect(r.id).toBe(ccpA1RoleScopeId(r.role_id, r.scope_id));
      expect(r.id).not.toMatch(/^01900000-/);
    }
    expect(ccpA1RoleScopeId(SEED_IDS.roles.platform_owner, SEED_IDS.scopes[ENTRY])).toBe(
      (() => {
        const h = createHash('md5').update(`ccp-a1:${SEED_IDS.roles.platform_owner}:${SEED_IDS.scopes[ENTRY]}`).digest('hex');
        return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
      })(),
    );
  });
});

describe('CCP A1 §4.3 — bundle invariants', () => {
  it('INV-1 — super_admin holds exactly its 10 existing scopes and 0 commercial scopes', async () => {
    const { bundles } = await seeded();
    expect([...(bundles.get('super_admin') ?? [])].sort()).toEqual(SUPER_ADMIN_BUNDLE);
    for (const s of COMMERCIAL) expect(bundles.get('super_admin')?.has(s), s).toBe(false);
  });

  it('INV-2 — no single CCP bundle is both initiator and decider in any domain', async () => {
    const { bundles } = await seeded();
    for (const role of CCP_ROLES) expect(makerCheckerOverlap(bundles.get(role) ?? new Set()), role).toEqual([]);
  });

  it('INV-3 — every CCP role holds only platform:* scopes; no other role holds any of the 15', async () => {
    const { bundles } = await seeded();
    for (const role of CCP_ROLES) for (const s of bundles.get(role) ?? []) expect(s.startsWith('platform:'), `${role} ${s}`).toBe(true);
    for (const [role, scopes] of bundles) {
      if ((CCP_ROLES as readonly string[]).includes(role)) continue;
      for (const s of COMMERCIAL) expect(scopes.has(s), `${role} holds ${s}`).toBe(false);
    }
  });

  it('INV-4 — no CCP role holds tenant provision / lifecycle, admin invite, skill, document-template or matching-policy scopes', async () => {
    const { bundles } = await seeded();
    const forbidden = (s: string) =>
      s === 'platform:tenant:provision' ||
      s === 'platform:tenant:lifecycle:manage' ||
      s === 'platform:admin:invite' ||
      s.startsWith('platform:skill:') ||
      s.startsWith('platform:document_template:') ||
      s.startsWith('platform:matching_policy:');
    for (const role of CCP_ROLES) expect([...(bundles.get(role) ?? [])].filter(forbidden), role).toEqual([]);
  });
});

describe('CCP A1 §5 / §7.1 — partitions and totals', () => {
  it('measured: 25 role rows / 24 / 7 / 17 / 11 / 13 / 205 / 25 / 180 / 984 / 10', async () => {
    const { roles, unique, scopes, bundles } = await seeded();
    expect(new Set(roles.map((r) => r['id'])).size).toBe(25);
    expect(SEED_ROLE_KEYS).toHaveLength(24);
    expect(PLATFORM_ROLE_KEYS).toHaveLength(7);
    expect(TENANT_ASSIGNABLE_ROLE_KEYS).toHaveLength(17);
    expect(ATS_PRODUCT_ROLE_KEYS).toHaveLength(11);
    expect(SEED_ROLE_KEYS.filter((k) => !ATS_PRODUCT_ROLE_KEYS.includes(k))).toHaveLength(13);
    expect(SEED_SCOPE_KEYS).toHaveLength(205);
    expect(new Set(scopes.map((s) => s['id'])).size).toBe(205);
    expect(PLATFORM_SCOPE_KEYS).toHaveLength(25);
    expect(SEED_SCOPE_KEYS.filter((k) => !k.startsWith('platform:'))).toHaveLength(180);
    expect(unique.size).toBe(984);
    expect(bundles.get('super_admin')?.size).toBe(10);
  });

  it('§7.1 — the 6 keys are platform-tier only; TENANT_ASSIGNABLE_ROLE_KEYS is the pre-A1 list, same order', () => {
    for (const k of CCP_ROLES) {
      expect(PLATFORM_ROLE_KEYS as readonly string[]).toContain(k);
      expect(TENANT_ASSIGNABLE_ROLE_KEYS).not.toContain(k);
      expect(ATS_PRODUCT_ROLE_KEYS).not.toContain(k);
      expect(ESIGN_PRODUCT_ROLE_KEYS).not.toContain(k);
      expect(ORG_ROLE_KEYS as readonly string[]).not.toContain(k);
      expect(k.startsWith('sign_')).toBe(false);
    }
    // The 17-key tenant list at 78dbd6d3, in order (the portal-user role taken from
    // SEED_ROLE_KEYS by position, so its key is not restated here).
    const portalUser = SEED_ROLE_KEYS[2];
    expect([...TENANT_ASSIGNABLE_ROLE_KEYS]).toEqual([
      'ats_admin', 'recruiter', portalUser, 'tenant_owner', 'account_manager', 'sourcer', 'finance', 'auditor',
      'recruiting_manager', 'delivery_manager', 'lead_recruiter', 'back_office', 'auditor_with_financials',
      'tenant_admin', 'sign_admin', 'sign_sender', 'sign_viewer',
    ]);
  });

  it('the 15 scope keys are in SEED_SCOPE_KEYS and PLATFORM_SCOPE_KEYS, match SCOPE_KEY_FORMAT, and sit on 0x326..0x334', () => {
    COMMERCIAL.forEach((k, i) => {
      expect(SEED_SCOPE_KEYS as readonly string[]).toContain(k);
      expect(PLATFORM_SCOPE_KEYS as readonly string[]).toContain(k);
      expect(k).toMatch(SCOPE_KEY_FORMAT);
      expect(SEED_IDS.scopes[k]).toBe(`01900000-0000-7000-8000-${(0x326 + i).toString(16).padStart(12, '0')}`);
    });
    CCP_ROLES.forEach((k, i) => expect(SEED_IDS.roles[k]).toBe(`01900000-0000-7000-8000-0000000002c${i}`));
  });

  it('§6.3.4 — the CCP bundle is not an ATS grant source: ats_admin derives no platform:* scope', () => {
    expect(ROLES1_ATS_ADMIN_SCOPES.filter((s) => s.startsWith('platform:'))).toEqual([]);
  });

  it('A0-C1 — no seed (dev fixtures included) assigns any CCP role to any membership', async () => {
    const { membershipRoles } = await seeded(true);
    expect(membershipRoles.length).toBeGreaterThan(0);
    for (const m of membershipRoles) expect(ccpRoleIds.has(m['role_id'] as string)).toBe(false);
  });
});

describe('CCP A1 §6.8 — seed descriptions', () => {
  it('role descriptions are the §6.8 text, written active', async () => {
    expect(CCP_A1_ROLE_DESCRIPTIONS).toEqual({
      platform_owner: 'Platform Owner — CCP final approver: approves and publishes catalog versions; approves subscription, entitlement and billing changes. Platform tier; platform:* scopes only.',
      finance_admin: 'Finance Admin — CCP financial approver for catalog, subscription, entitlement and billing changes; reads the commercial audit. Platform tier; platform:* scopes only.',
      commercial_ops: 'Commercial Ops — CCP requester for subscription, entitlement and billing changes; never approves. Platform tier; platform:* scopes only.',
      catalog_manager: 'Catalog Manager — CCP catalog author: drafts catalog versions; never approves or publishes. Platform tier; platform:* scopes only.',
      support_admin: 'Support Admin — CCP support: applies bounded support exceptions under the active commercial policy; reads subscriptions and billing status. Platform tier; platform:* scopes only.',
      read_only_auditor: 'Read-only Auditor — CCP read access to catalog, subscriptions, billing status, approvals and the commercial audit. No write. Platform tier; platform:* scopes only.',
    });
    const { roles } = await seeded();
    for (const k of CCP_ROLES) {
      const row = roles.find((r) => r['key'] === k);
      expect(row, k).toMatchObject({ id: SEED_IDS.roles[k], description: CCP_A1_ROLE_DESCRIPTIONS[k], is_active: true });
    }
  });

  it('scope descriptions follow "Platform-tier CCP: <verb phrase> (enforced from CCP <slice>)"', async () => {
    expect(Object.keys(CCP_A1_SCOPE_DESCRIPTIONS)).toEqual([...COMMERCIAL]);
    for (const d of Object.values(CCP_A1_SCOPE_DESCRIPTIONS)) expect(d).toMatch(/^Platform-tier CCP: [a-z].* \(enforced from CCP [A-Z0-9 +]+\)$/);
    const { scopes } = await seeded();
    for (const k of COMMERCIAL) expect(scopes.find((s) => s['key'] === k)?.['description']).toBe(CCP_A1_SCOPE_DESCRIPTIONS[k]);
  });
});

describe('CCP A1 §7.3(d)(e) — tenant-side surfaces never carry the new roles or scopes', () => {
  async function catalogRows(includeCcp: boolean) {
    const { roles, bundles } = await seeded();
    return roles
      .filter((r) => r['is_active'] !== false)
      .filter((r) => includeCcp || !(CCP_ROLES as readonly string[]).includes(r['key'] as string))
      .map((r) => ({
        key: r['key'] as string,
        description: r['description'] as string,
        role_scopes: [...(bundles.get(r['key'] as string) ?? [])].map((k) => ({ scope: { key: k } })),
      }));
  }
  const svc = (rows: unknown[], caps: readonly string[]) =>
    new RoleCatalogService({ role: { findMany: async () => rows } } as never, { getCapabilities: async () => new Set(caps) } as never);

  it('(d) the tenant role catalog lists none of them, and its projection is byte-identical to the pre-A1 one for every capability set', async () => {
    const withCcp = await catalogRows(true);
    const without = await catalogRows(false);
    for (const caps of [['core'], ['core', 'ats'], ['core', 'sign'], ['core', 'ats', 'sign']]) {
      const a = await svc(withCcp, caps).getCatalog({ tenant_id: '01900000-0000-7000-8000-000000000001' });
      const b = await svc(without, caps).getCatalog({ tenant_id: '01900000-0000-7000-8000-000000000001' });
      expect(JSON.stringify(a), caps.join('+')).toBe(JSON.stringify(b));
      for (const k of [...CCP_ROLES, 'super_admin']) expect(a.some((r) => r.key === k), k).toBe(false);
    }
    const noTenant = await svc(withCcp, ['core', 'ats']).getCatalog();
    for (const k of CCP_ROLES) expect(noTenant.some((r) => r.key === k)).toBe(false);
  });

  it('(e) filterScopesForConsumer yields the 15 only for the platform consumer', async () => {
    const { bundles } = await seeded();
    for (const role of CCP_ROLES) {
      const scopes = [...(bundles.get(role) ?? [])];
      for (const consumer of ['recruiter', 'org', 'sign', 'portal', 'ingestion']) {
        for (const tenantHasEsign of [false, true]) {
          const out = filterScopesForConsumer({ consumer, scopes, tenantHasEsign });
          expect(out.filter((s) => (COMMERCIAL as readonly string[]).includes(s)), `${role}/${consumer}`).toEqual([]);
          expect(out.filter((s) => s.startsWith('platform:')), `${role}/${consumer}`).toEqual([]);
        }
      }
      expect(filterScopesForConsumer({ consumer: 'platform', scopes, tenantHasEsign: false }).sort()).toEqual(expectedBundle(role));
    }
  });
});

describe('CCP A1 §8 — reused identities at catalog level (A3 enforces; A1 documents)', () => {
  it('reports the maker/checker overlap of every pair of the 6 roles; FA + PO is the double-decider A3 case', async () => {
    const { bundles } = await seeded();
    const report: Record<string, string[]> = {};
    for (let i = 0; i < CCP_ROLES.length; i++) {
      for (let j = i + 1; j < CCP_ROLES.length; j++) {
        const a = CCP_ROLES[i] as CcpRole;
        const b = CCP_ROLES[j] as CcpRole;
        const union = new Set([...(bundles.get(a) ?? []), ...(bundles.get(b) ?? [])]);
        const overlap = makerCheckerOverlap(union);
        if (overlap.length) report[`${a}+${b}`] = overlap;
      }
    }
    // 15 pairs; these 6 unions can both initiate and decide in a domain. One user holding
    // such a pair is refused at approve time by A3 (USER_ALREADY_APPROVED / requester ≠
    // approver), never by the catalog. The other 9 pairs show no overlap.
    expect(report).toEqual({
      'platform_owner+commercial_ops': ['subscription', 'entitlement', 'billing'],
      'platform_owner+catalog_manager': ['catalog'],
      'platform_owner+support_admin': ['subscription'],
      'finance_admin+commercial_ops': ['subscription', 'entitlement', 'billing'],
      'finance_admin+catalog_manager': ['catalog'],
      'finance_admin+support_admin': ['subscription'],
    });
    // FA + PO: no initiator, but both decide in every domain (two approval steps, one
    // person) — the A3 NC-2 negative case.
    const faPo = new Set([...(bundles.get('finance_admin') ?? []), ...(bundles.get('platform_owner') ?? [])]);
    for (const d of Object.values(DOMAINS)) expect(d.decide.some((s) => faPo.has(s))).toBe(true);
    // INV-1: the D7 bootstrap operator's super_admin adds no commercial scope to any union.
    for (const role of CCP_ROLES) {
      const union = new Set([...(bundles.get(role) ?? []), ...(bundles.get('super_admin') ?? [])]);
      expect(makerCheckerOverlap(union), `super_admin+${role}`).toEqual(makerCheckerOverlap(bundles.get(role) ?? new Set()));
    }
  });
});

describe('CCP A1 §10.2 — regression: every pre-A1 row byte-identical (fingerprints taken at 78dbd6d3)', () => {
  it('the 939 RoleScope rows of the 19 existing roles (ids included), the 19 role rows and the 190 scope rows are unchanged', async () => {
    const { unique, roles, scopes } = await seeded();
    const rs = [...unique.values()].filter((r) => !ccpRoleIds.has(r.role_id)).map((r) => `${r.id}|${r.role_id}|${r.scope_id}`);
    expect(rs).toHaveLength(939);
    expect(sha(rs)).toBe('e4de0c78d6196a80f94b7847199f6539b9ae9e54f618e354ca8abf1eb6975e90');
    const rr = roles.filter((r) => !(CCP_ROLES as readonly string[]).includes(r['key'] as string)).map((r) => `${r['id']}|${r['key']}|${r['description']}|${r['is_active']}`);
    expect(rr).toHaveLength(19);
    expect(sha(rr)).toBe('e6aba93cecadec1f782a5e3caa90e4ce7745234807c8afd62a94f3b19c440bef');
    const sc = scopes.filter((s) => !(COMMERCIAL as readonly string[]).includes(s['key'] as string)).map((s) => `${s['id']}|${s['key']}|${s['description']}`);
    expect(sc).toHaveLength(190);
    expect(sha(sc)).toBe('09508e83113503c5e2f2a55bf39db0bb3db2fc46559248a62996e21976ef9e74');
  });
});
