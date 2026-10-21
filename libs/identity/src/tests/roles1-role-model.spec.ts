import { describe, expect, it } from 'vitest';

import {
  ROLES1_ADMIN_SIGN_SCOPES,
  ROLES1_ATS_ADMIN_SCOPES,
  ROLES1_OWNER_SIGN_SCOPES,
  ROLES1_ROLE_DESCRIPTIONS,
  SEED_IDS,
  roles1RoleScopeId,
  runIdentitySeed,
} from '../../prisma/seed.js';
import {
  ATS_PRODUCT_ROLE_KEYS,
  ESIGN_PRODUCT_ROLE_KEYS,
  ORG_ADMIN_SCOPE_KEYS,
  ORG_ROLE_KEYS,
  SEED_ROLE_KEYS,
} from '../lib/dto/role.dto.js';
import { SEE_ALL_ROLE_KEYS } from '../lib/tenant-user/role-bundle-validator.js';
import { TENANT_ACTIVATING_OWNER_ROLE_KEYS } from '../lib/util/tenant-kind.js';

// ROLES-1 PR-2 — Aramo-ROLES-1 Implementation Directive v1.0 (LOCKED) §3 (bundles,
// partitions, owner-only narrowing) and §6 (seed defaults), proved against the seed the
// way every fresh database is built (a recording Prisma — no database).

type Row = Record<string, unknown>;
interface Recorded {
  roleScopes: { id: string; role_id: string; scope_id: string }[];
  roles: Row[];
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

async function seeded(includeDevFixtures = false): Promise<Recorded & { bundles: Map<string, Set<string>>; pairs: number }> {
  const rec: Recorded = { roleScopes: [], roles: [], membershipRoles: [] };
  await runIdentitySeed(makeRecordingPrisma(rec), { includeDevFixtures });
  const bundles = new Map<string, Set<string>>();
  const pairs = new Set<string>();
  for (const r of rec.roleScopes) {
    const role = roleIdToKey.get(r.role_id) ?? r.role_id;
    const scope = scopeIdToKey.get(r.scope_id) ?? r.scope_id;
    if (!bundles.has(role)) bundles.set(role, new Set());
    bundles.get(role)?.add(scope);
    pairs.add(`${r.role_id}:${r.scope_id}`);
  }
  return { ...rec, bundles, pairs: pairs.size };
}

const SIX_ORG_WIDE = [
  'tenant:admin:profile',
  'tenant:admin:domain',
  'tenant:admin:sites',
  'tenant:admin:user-manage',
  'tenant:admin:settings',
  'audit:read',
];

describe('ROLES-1 PR-2 §3.3 — partitions', () => {
  it('ORG_ROLE_KEYS = tenant_owner + tenant_admin; in no product partition', () => {
    expect([...ORG_ROLE_KEYS]).toEqual(['tenant_owner', 'tenant_admin']);
    for (const k of ORG_ROLE_KEYS) {
      expect(ATS_PRODUCT_ROLE_KEYS).not.toContain(k);
      expect(ESIGN_PRODUCT_ROLE_KEYS).not.toContain(k);
    }
  });
  it('ats_admin is an ATS product role; org_admin no longer exists', () => {
    expect(ATS_PRODUCT_ROLE_KEYS).toContain('ats_admin');
    expect(SEED_ROLE_KEYS).toContain('ats_admin');
    expect(SEED_ROLE_KEYS as readonly string[]).not.toContain('org_admin');
  });
  it('SEE_ALL_ROLE_KEYS adds ats_admin and keeps tenant_admin / tenant_owner', () => {
    for (const k of ['ats_admin', 'tenant_admin', 'tenant_owner']) expect(SEE_ALL_ROLE_KEYS.has(k)).toBe(true);
  });
  it('§3.4 — owner activation is keyed to tenant_owner only', () => {
    expect(TENANT_ACTIVATING_OWNER_ROLE_KEYS).toEqual(['tenant_owner']);
  });
});

describe('ROLES-1 PR-2 §3.2 — the seeded bundles', () => {
  it('tenant_owner = its ATS/org bundle + the Sign owner set (incl. sign:billing:manage), never sign:template:*', async () => {
    const { bundles } = await seeded();
    const owner = bundles.get('tenant_owner') ?? new Set();
    for (const k of ROLES1_OWNER_SIGN_SCOPES) expect(owner.has(k), k).toBe(true);
    expect(owner.has('sign:billing:manage')).toBe(true);
    expect(owner.has('sign:envelope:send')).toBe(true);
    expect(owner.has('sign:template:use')).toBe(false);
    expect(owner.has('sign:template:manage')).toBe(false);
    expect(ROLES1_OWNER_SIGN_SCOPES).toHaveLength(11);
  });

  it('tenant_admin = the org set + every ats_admin scope + the Sign admin set; no billing', async () => {
    const { bundles } = await seeded();
    const admin = bundles.get('tenant_admin') ?? new Set();
    const ats = bundles.get('ats_admin') ?? new Set();
    for (const k of ORG_ADMIN_SCOPE_KEYS) expect(admin.has(k), k).toBe(true);
    for (const k of ats) expect(admin.has(k), `ats_admin scope ${k}`).toBe(true);
    for (const k of ROLES1_ADMIN_SIGN_SCOPES) expect(admin.has(k), k).toBe(true);
    expect(admin.has('sign:envelope:send')).toBe(true);
    expect(admin.has('sign:billing:manage')).toBe(false);
    expect(admin.has('sign:template:use')).toBe(false);
    expect(ROLES1_ADMIN_SIGN_SCOPES).toHaveLength(10);
    // The static derivation equals what the seed actually grants ats_admin (a new bundle
    // source missing from ROLES1_ATS_GRANT_SOURCES would fail here).
    expect([...ROLES1_ATS_ADMIN_SCOPES].sort()).toEqual([...ats].sort());
    // Exactly: org set ∪ ats_admin ∪ Sign admin set ∪ the organization template pair
    // (DOC-TEMPLATE-LIB-1 T-4 §6.3: document_template:manage left ats_admin, kept here).
    expect([...admin].sort()).toEqual(
      [...new Set([...ORG_ADMIN_SCOPE_KEYS, ...ats, ...ROLES1_ADMIN_SIGN_SCOPES, 'document_template:read', 'document_template:manage'])].sort(),
    );
  });

  it('ats_admin loses the six organization-wide scopes (D-2), keeps auth:session:read + directory (F-6), never Sign', async () => {
    const { bundles } = await seeded();
    const ats = bundles.get('ats_admin') ?? new Set();
    for (const k of SIX_ORG_WIDE) expect(ats.has(k), k).toBe(false);
    expect(ats.has('auth:session:read')).toBe(true);
    expect(ats.has('tenant:user:read:directory')).toBe(true);
    expect([...ats].some((k) => k.startsWith('sign:'))).toBe(false);
    // Today's 146 minus the six, minus document_template:manage (DOC-TEMPLATE-LIB-1 T-4
    // §6.3: template administration moved to the organization roles) → 139.
    // Remediation v1.0 R3 (DEF-15(b)) +1 pipeline:re-add → 140.
    expect(ats.size).toBe(140);
    expect(ats.has('document_template:manage')).toBe(false);
    expect(ats.has('document_template:read')).toBe(true);
  });

  it('the owner holds everything the administrator holds, plus billing', async () => {
    const { bundles } = await seeded();
    const owner = bundles.get('tenant_owner') ?? new Set();
    const admin = bundles.get('tenant_admin') ?? new Set();
    for (const k of admin) expect(owner.has(k), k).toBe(true);
    expect([...owner].filter((k) => !admin.has(k))).toEqual(['sign:billing:manage']);
  });

  it('pins the role-scope totals (seed simulation; the migration is relational and never assumes them)', async () => {
    const { bundles, pairs } = await seeded();
    // Baseline 788 (786 + DOC-TEMPLATE-LIB-1 T-2's 2 super_admin platform grants) → −6
    // (ats_admin D-2) +11 (tenant_owner Sign) +148 (tenant_admin: 140 ats_admin + 10 Sign −
    // the 2 baseline scopes already in its org set) = 941.
    // DOC-TEMPLATE-LIB-1 T-4 (§6.3): −1 (ats_admin × document_template:manage) +2
    // (sign_admin, sign_sender × document_template:read) → 942. tenant_owner/tenant_admin
    // already held both template scopes (sizes unchanged). ROLES-1 PR-3: −13 (the retired
    // sign_owner's 3 sender + 10 contract grants are no longer seeded) = 929.
    expect(bundles.get('tenant_owner')?.size).toBe(158); // Remediation v1.0 R3 +1 pipeline:re-add → 158.
    expect(bundles.get('tenant_admin')?.size).toBe(157); // Remediation v1.0 R3 +1 pipeline:re-add (derived from ats_admin) → 157.
    expect(bundles.get('ats_admin')?.size).toBe(140); // Remediation v1.0 R3 +1 pipeline:re-add → 140.
    // DOC-TEMPLATE-LIB-1 T-5: −3 (sign_admin × sign:template:{use,manage}, sign_sender ×
    // sign:template:use) → 926. Remediation v1.0 R3: +5 pipeline:re-add (ats_admin, lead_recruiter,
    // recruiting_manager, tenant_owner + tenant_admin derived) → 931.
    expect(pairs).toBe(931);
  });

  it('the ROLES-1 RoleScope rows carry the migration-identical deterministic id', async () => {
    const { roleScopes } = await seeded();
    const billing = SEED_IDS.scopes['sign:billing:manage'];
    const row = roleScopes.find((r) => r.role_id === SEED_IDS.roles.tenant_owner && r.scope_id === billing);
    expect(row?.id).toBe(roles1RoleScopeId(SEED_IDS.roles.tenant_owner, billing));
    // md5-shaped, disjoint from the 01900000-… seed ranges.
    expect(row?.id).not.toMatch(/^01900000-/);
  });
});

describe('ROLES-1 PR-2 §1/§6 — seeded roles and the dev admin', () => {
  it('row ids keep their keys swapped; descriptions carry the new display names; sign_owner is created inactive', async () => {
    const { roles } = await seeded();
    const byId = new Map(roles.map((r) => [r['id'] as string, r]));
    expect(SEED_IDS.roles.ats_admin).toBe('01900000-0000-7000-8000-000000000010');
    expect(SEED_IDS.roles.tenant_admin).toBe('01900000-0000-7000-8000-0000000002b0');
    expect(byId.get(SEED_IDS.roles.ats_admin)?.['key']).toBe('ats_admin');
    expect(byId.get(SEED_IDS.roles.tenant_admin)?.['key']).toBe('tenant_admin');
    expect(byId.get(SEED_IDS.roles.ats_admin)?.['description']).toBe(ROLES1_ROLE_DESCRIPTIONS.ats_admin);
    expect(byId.get(SEED_IDS.roles.tenant_admin)?.['description']).toBe(ROLES1_ROLE_DESCRIPTIONS.tenant_admin);
    expect(byId.get(SEED_IDS.roles.tenant_owner)?.['description']).toBe(ROLES1_ROLE_DESCRIPTIONS.tenant_owner);
    expect(String(ROLES1_ROLE_DESCRIPTIONS.ats_admin)).toMatch(/^ATS Admin — /);
    expect(String(ROLES1_ROLE_DESCRIPTIONS.tenant_admin)).toMatch(/^Tenant Admin — /);
    expect(String(ROLES1_ROLE_DESCRIPTIONS.tenant_owner)).toMatch(/^Tenant Owner — /);
    expect(byId.get(SEED_IDS.roles.sign_owner)?.['is_active']).toBe(false);
    expect(roles.some((r) => r['key'] === 'org_admin')).toBe(false);
  });

  // ROLES-1 PR-3 (§1, §8) — sign_owner is retired: its row is still seeded (inactive,
  // history) but it gets no RoleScope row; the frozen id layouts keep every other Sign
  // grant's deterministic id where it was before PR-3 (append-don't-renumber).
  it('PR-3: the retired sign_owner gets no bundle; the Sign grants keep their pre-PR-3 RoleScope ids', async () => {
    const { roles, roleScopes, bundles } = await seeded();
    expect(roles.some((r) => r['key'] === 'sign_owner' && r['is_active'] === false)).toBe(true);
    expect(roleScopes.some((r) => r.role_id === SEED_IDS.roles.sign_owner)).toBe(false);
    expect(bundles.has('sign_owner')).toBe(false);
    const idOf = (role: keyof typeof SEED_IDS.roles, scope: keyof typeof SEED_IDS.scopes) =>
      roleScopes.find((r) => r.role_id === SEED_IDS.roles[role] && r.scope_id === SEED_IDS.scopes[scope])?.id;
    // 0x1350..0x1352 stay reserved for the retired sign_owner; sign_admin keeps 0x1353+.
    expect(idOf('sign_admin', 'sign:envelope:create')).toBe('01900000-0000-7000-8000-000000001353');
    expect(idOf('sign_viewer', 'sign:envelope:read')).toBe('01900000-0000-7000-8000-000000001359');
    // 0x1720..0x1729 stay reserved for sign_owner's former contract; sign_admin starts at 0x172a.
    expect(idOf('sign_admin', 'sign:envelope:read:all')).toBe('01900000-0000-7000-8000-00000000172a');
  });

  it('the dev admin holds ats_admin + tenant_admin (§6)', async () => {
    const { membershipRoles } = await seeded(true);
    const mine = membershipRoles.filter((r) => r['membership_id'] === SEED_IDS.membership_admin).map((r) => roleIdToKey.get(r['role_id'] as string));
    expect(mine.sort()).toEqual(['ats_admin', 'tenant_admin']);
  });
});
