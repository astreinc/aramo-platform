import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { RoleRepository } from '../lib/role.repository.js';
import { RoleService } from '../lib/role.service.js';
import { IdentityRepository } from '../lib/identity.repository.js';
import { IdentityService } from '../lib/identity.service.js';
import { AuthorizationVersionService } from '../lib/authorization-version.service.js';
import { InMemoryScopeCache } from '../lib/authorization/in-memory-scope-cache.js';
import { IdentityEffectiveAuthorizationResolver } from '../lib/authorization/identity-effective-authorization-resolver.js';
import { RoleBundleValidator } from '../lib/tenant-user/role-bundle-validator.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';
import {
  CCP_A1_ROLE_DESCRIPTIONS,
  CCP_A1_SCOPE_DESCRIPTIONS,
  CCP_PLATFORM_ROLE_SEED_BUNDLES,
  SEED_IDS,
  ccpA1RoleScopeId,
  runIdentitySeed,
} from '../../prisma/seed.js';

// CCP A1 — Aramo-CCP-A1-Commercial-Roles-and-Scopes-Directive-v1_0 (LOCKED) §6.4 / §6.7.4 / §8,
// on real Postgres:
//   1. fresh database: identity migrations (the block is a no-op without a role catalog) + the
//      seed, which writes the 6 / 15 / 45 model directly — its rows are the reference;
//   2. migrate after seed: nothing inserted, nobody bumped;
//   3. rewound to the pre-A1 state (no CCP rows, as in production per P-7) with live
//      memberships: the migration ensures 6 / 15 / 45 seed-identical rows and bumps nobody;
//   4. a re-run and a seed re-run change nothing;
//   5. fail-closed fixtures (conflicting id, conflicting key, a non-empty bump set, bundle
//      drift, description drift) RAISE and apply nothing;
//   6. §8 role revocation between request and approval, at catalog level (NC-4): a CCP role
//      granted through the service (allow_platform_roles, test fixture only) and then removed
//      leaves none of its commercial scopes on the next resolution, and the principal's
//      AuthorizationVersion advanced.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = 'libs/identity/prisma/migrations/20261024120000_ccp_a1_commercial_role_catalog/migration.sql';
const CCP_ROLES = ['platform_owner', 'finance_admin', 'commercial_ops', 'catalog_manager', 'support_admin', 'read_only_auditor'] as const;
const COMMERCIAL = Object.keys(CCP_A1_SCOPE_DESCRIPTIONS);
const ROLE_IDS = CCP_ROLES.map((k) => SEED_IDS.roles[k]);
const SCOPE_IDS = COMMERCIAL.map((k) => SEED_IDS.scopes[k as keyof typeof SEED_IDS.scopes]);
// CCP-R3: the successor CCP-A1 Amendment A1 (platform:billing:amount:read, 0x335, 3 grants) is
// proven by ccp-a1a1-finance-amount-scope-migration.integration.spec.ts; the A1 model views below
// leave its rows out, and the rewound pre-A1 state re-applies it after A1 (production order).
const AMOUNT_SCOPE_ID = SEED_IDS.scopes['platform:billing:amount:read'];
const A1A1_MIGRATION = 'libs/identity/prisma/migrations/20261028060000_ccp_a1a1_finance_amount_scope/migration.sql';

// The two splitter shapes used by identity migration consumers (ic1-migration spec): the
// regex form and the quote-aware scanner. The file must be ONE statement under both.
const regexSplit = (sql: string): string[] =>
  sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
function quoteAwareSplit(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inLineComment = false;
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      cur += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inQuote) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i++;
        } else inQuote = false;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (ch === "'") inQuote = true;
    if (ch === ';') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));
}

type Member = { tenant_id: string; user_id: string; membership_id: string };

describe('CCP A1 — commercial role catalog migration (real PG)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  const notices: string[] = [];
  let seedModel: string;
  let recruiter: Member, superAdmin: Member;

  const run = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const migrationSql = () => readFileSync(resolve(ROOT, MIGRATION), 'utf8');
  const applyMigration = () => run(migrationSql());

  // The CCP rows only, with ids: the seed/migration convergence reference.
  async function ccpModel(): Promise<string> {
    const parts = await Promise.all([
      run(`SELECT id, key, description, is_active FROM identity."Role" WHERE id = ANY($1::uuid[]) ORDER BY id`, [ROLE_IDS]),
      run(`SELECT id, key, description FROM identity."Scope" WHERE id = ANY($1::uuid[]) ORDER BY id`, [SCOPE_IDS]),
      run(`SELECT id, role_id, scope_id FROM identity."RoleScope" WHERE role_id = ANY($1::uuid[]) AND scope_id <> $2::uuid ORDER BY id`, [ROLE_IDS, AMOUNT_SCOPE_ID]),
    ]);
    return JSON.stringify(parts.map((p) => p.rows));
  }
  async function snapshot(): Promise<string> {
    const parts = await Promise.all([
      run(`SELECT id, key, description, is_active FROM identity."Role" ORDER BY id`),
      run(`SELECT id, key, description FROM identity."Scope" ORDER BY id`),
      run(`SELECT id, role_id, scope_id FROM identity."RoleScope" ORDER BY id`),
      run(`SELECT tenant_id, principal_id, version FROM identity."AuthorizationVersion" ORDER BY tenant_id, principal_id`),
    ]);
    return JSON.stringify(parts.map((p) => p.rows));
  }
  async function counts(): Promise<[number, number, number]> {
    const r = await run(
      `SELECT (SELECT count(*) FROM identity."Role" WHERE id = ANY($1::uuid[]))::int AS r,
              (SELECT count(*) FROM identity."Scope" WHERE id = ANY($2::uuid[]))::int AS s,
              (SELECT count(*) FROM identity."RoleScope" WHERE role_id = ANY($1::uuid[]) AND scope_id <> $3::uuid)::int AS g`,
      [ROLE_IDS, SCOPE_IDS, AMOUNT_SCOPE_ID],
    );
    return [r.rows[0].r, r.rows[0].s, r.rows[0].g];
  }
  async function rewind(): Promise<void> {
    await run(`DELETE FROM identity."RoleScope" WHERE role_id = ANY($1::uuid[]) OR scope_id = ANY($2::uuid[]) OR scope_id = $3::uuid`, [ROLE_IDS, SCOPE_IDS, AMOUNT_SCOPE_ID]);
    await run(`DELETE FROM identity."Scope" WHERE id = $1::uuid`, [AMOUNT_SCOPE_ID]);
    await run(`DELETE FROM identity."Scope" WHERE id = ANY($1::uuid[])`, [SCOPE_IDS]);
    await run(`DELETE FROM identity."Role" WHERE id = ANY($1::uuid[])`, [ROLE_IDS]);
  }
  async function member(tenant_id: string, roles: string[]): Promise<Member> {
    const user_id = uuidv7();
    const membership_id = uuidv7();
    await run(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `ccpa1-${user_id}@acme.test`, tenant_id]);
    await run(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [membership_id, user_id, tenant_id]);
    for (const role_id of roles) {
      await run(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), membership_id, role_id]);
    }
    return { tenant_id, user_id, membership_id };
  }
  async function tenant(): Promise<string> {
    const t = uuidv7();
    await run(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, $2, 'ACTIVE', now())`, [t, `CCPA1 ${t}`]);
    return t;
  }
  const lastNotice = (re: RegExp) => notices.some((n) => re.test(n));

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    db.on('notice', (n) => notices.push(n.message ?? ''));
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    seedModel = await ccpModel();
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('registration — after ATS-QA-1 and the geo step-up; only CCP-A9 (last-owner invariant) follows it; stamps in apply order', () => {
    // CCP-A9 appended its last-effective-platform_owner trigger migration after this one.
    expect(IDENTITY_MIGRATIONS.slice(IDENTITY_MIGRATIONS.indexOf(MIGRATION) + 1)).toEqual([
      'libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql',
      // CCP-R3: the CCP-A1 Amendment A1 Finance amount scope.
      'libs/identity/prisma/migrations/20261028060000_ccp_a1a1_finance_amount_scope/migration.sql',
    ]);
    for (const dep of [
      'libs/identity/prisma/migrations/20261022150000_ats_qa_1_resume_select_grants/migration.sql',
      'libs/identity/prisma/migrations/20261024100000_sign_personal_geo_step_up/migration.sql',
    ]) {
      expect(IDENTITY_MIGRATIONS.indexOf(MIGRATION)).toBeGreaterThan(IDENTITY_MIGRATIONS.indexOf(dep));
    }
    const stamps = IDENTITY_MIGRATIONS.map((p) => p.split('/').at(-2) ?? '');
    expect((stamps.at(-1) ?? '') > (stamps.at(-2) ?? '')).toBe(true);
  });

  it('splitter safety — one statement under the regex and the quote-aware splitter; no $$', () => {
    const sql = migrationSql();
    expect(regexSplit(sql)).toHaveLength(1);
    expect(quoteAwareSplit(sql)).toHaveLength(1);
    expect(sql).not.toContain('$$');
  });

  it('empty catalog — the block ran as a no-op; the seed wrote 6 roles / 15 scopes / 45 grants with the md5 ids', async () => {
    expect(lastNotice(/ccp_a1: no role catalog yet/)).toBe(true);
    expect(await counts()).toEqual([6, 15, 45]);
    for (const [role, scopes] of CCP_PLATFORM_ROLE_SEED_BUNDLES) {
      const role_id = SEED_IDS.roles[role as (typeof CCP_ROLES)[number]];
      for (const scope of scopes) {
        const scope_id = SEED_IDS.scopes[scope as keyof typeof SEED_IDS.scopes];
        const row = await run(`SELECT id FROM identity."RoleScope" WHERE role_id = $1 AND scope_id = $2`, [role_id, scope_id]);
        expect(row.rows[0]?.id, `${role} ${scope}`).toBe(ccpA1RoleScopeId(role_id, scope_id));
      }
    }
    expect(await counts()).toEqual([6, 15, 45]);
  });

  it('migration after seed — inserts 0 / 0 / 0, bumps nobody, changes nothing', async () => {
    const t = await tenant();
    recruiter = await member(t, [SEED_IDS.roles.recruiter]);
    superAdmin = await member(t, [SEED_IDS.roles.super_admin]);
    await run(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES ($1, $2, $3, 4, now())`, [uuidv7(), t, recruiter.user_id]);
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(lastNotice(/ccp_a1: roles inserted: 0, scopes inserted: 0, grants inserted: 0/)).toBe(true);
    expect(lastNotice(/ccp_a1: authorization versions bumped: 0/)).toBe(true);
  });

  it('pre-A1 state (production per P-7) — ensures 6 / 15 / 45 seed-identical rows; 0 principals bumped', async () => {
    await rewind();
    expect(await counts()).toEqual([0, 0, 0]);
    const versionsBefore = (await run(`SELECT tenant_id, principal_id, version FROM identity."AuthorizationVersion" ORDER BY 1, 2`)).rows;
    notices.length = 0;
    await applyMigration();
    expect(await counts()).toEqual([6, 15, 45]);
    expect(await ccpModel()).toBe(seedModel);
    expect(lastNotice(/ccp_a1: roles inserted: 6, scopes inserted: 15, grants inserted: 45/)).toBe(true);
    // Production order: the CCP-A1 Amendment A1 migration follows (no member holds a CCP role here, so it bumps nobody).
    await run(readFileSync(resolve(ROOT, A1A1_MIGRATION), 'utf8'));
    expect((await run(`SELECT tenant_id, principal_id, version FROM identity."AuthorizationVersion" ORDER BY 1, 2`)).rows).toEqual(versionsBefore);
    // Descriptions byte-identical to the seed constants.
    for (const k of CCP_ROLES) {
      const r = await run(`SELECT description, is_active FROM identity."Role" WHERE id = $1`, [SEED_IDS.roles[k]]);
      expect(r.rows[0]).toEqual({ description: CCP_A1_ROLE_DESCRIPTIONS[k], is_active: true });
    }
    for (const k of COMMERCIAL) {
      const s = await run(`SELECT description FROM identity."Scope" WHERE key = $1`, [k]);
      expect(s.rows[0].description).toBe(CCP_A1_SCOPE_DESCRIPTIONS[k as keyof typeof CCP_A1_SCOPE_DESCRIPTIONS]);
    }
  });

  it('idempotent — a re-run inserts 0 rows and bumps 0 principals', async () => {
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(lastNotice(/ccp_a1: roles inserted: 0, scopes inserted: 0, grants inserted: 0/)).toBe(true);
    expect(lastNotice(/ccp_a1: authorization versions bumped: 0/)).toBe(true);
  });

  it('seed after migration — converges to identical rows and ids (changes nothing)', async () => {
    const before = await snapshot();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    expect(await snapshot()).toBe(before);
    expect(await ccpModel()).toBe(seedModel);
  });

  describe('fail closed — RAISE and apply nothing', () => {
    async function refused(re: RegExp): Promise<void> {
      const before = await snapshot();
      await expect(applyMigration()).rejects.toThrow(re);
      expect(await snapshot()).toBe(before);
    }
    const CONFLICT = /ccp_a1: role or scope id\/key conflict refused/;

    it('a target role id holding a different key', async () => {
      await rewind();
      await run(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1, 'ccp_probe_role', 'probe', true, now())`, [SEED_IDS.roles.platform_owner]);
      await refused(CONFLICT);
      await run(`DELETE FROM identity."Role" WHERE id = $1`, [SEED_IDS.roles.platform_owner]);
    });

    it('a target role key on a different id', async () => {
      await run(`INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1, 'finance_admin', 'probe', true, now())`, [uuidv7()]);
      await refused(CONFLICT);
      await run(`DELETE FROM identity."Role" WHERE key = 'finance_admin'`);
    });

    it('a target scope id holding a different key', async () => {
      await run(`INSERT INTO identity."Scope" (id, key, description) VALUES ($1, 'ccp:probe', 'probe')`, [SEED_IDS.scopes['platform:billing:read']]);
      await refused(CONFLICT);
      await run(`DELETE FROM identity."Scope" WHERE id = $1`, [SEED_IDS.scopes['platform:billing:read']]);
    });

    it('a target scope key on a different id', async () => {
      await run(`INSERT INTO identity."Scope" (id, key, description) VALUES ($1, 'platform:approval:read', 'probe')`, [uuidv7()]);
      await refused(CONFLICT);
      await run(`DELETE FROM identity."Scope" WHERE key = 'platform:approval:read'`);
      expect(await counts()).toEqual([0, 0, 0]);
    });

    it('a non-empty AuthorizationVersion bump set (a membership already holding a CCP role)', async () => {
      // The Role rows exist (no grants yet) and a membership holds platform_owner: applying
      // the 45 grants would change that principal's effective scopes, so the block refuses.
      await run(
        `INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1, 'platform_owner', $2, true, now())`,
        [SEED_IDS.roles.platform_owner, CCP_A1_ROLE_DESCRIPTIONS.platform_owner],
      );
      const holder = await member(await tenant(), [SEED_IDS.roles.platform_owner]);
      await refused(/ccp_a1: 1 principal\(s\) would change effective scopes, refused \(the bump set must be empty\)/);
      await run(`DELETE FROM identity."UserTenantMembershipRole" WHERE membership_id = $1`, [holder.membership_id]);
      await run(`DELETE FROM identity."UserTenantMembership" WHERE id = $1`, [holder.membership_id]);
      await run(`DELETE FROM identity."Role" WHERE id = $1`, [SEED_IDS.roles.platform_owner]);
      // Restore the full catalog for the drift fixtures below.
      await applyMigration();
      expect(await ccpModel()).toBe(seedModel);
    });

    it('a CCP bundle drifted from the approved matrix (an extra grant)', async () => {
      const extra = uuidv7();
      await run(`INSERT INTO identity."RoleScope" (id, role_id, scope_id) VALUES ($1, $2, $3)`, [extra, SEED_IDS.roles.catalog_manager, SEED_IDS.scopes['platform:catalog:approve']]);
      await refused(/ccp_a1: a CCP role bundle differs from the approved matrix, refused/);
      await run(`DELETE FROM identity."RoleScope" WHERE id = $1`, [extra]);
    });

    it('a role row whose description differs from the seed definition', async () => {
      await run(`UPDATE identity."Role" SET description = 'edited' WHERE id = $1`, [SEED_IDS.roles.support_admin]);
      await refused(/ccp_a1: role or scope row differs from the seed definition, refused/);
      await run(`UPDATE identity."Role" SET description = $2 WHERE id = $1`, [SEED_IDS.roles.support_admin, CCP_A1_ROLE_DESCRIPTIONS.support_admin]);
      expect(await ccpModel()).toBe(seedModel);
    });
  });

  it('the 939 pre-A1 RoleScope rows and the 19 pre-A1 role rows are untouched by every run above', async () => {
    const rs = await run(`SELECT count(*)::int AS n FROM identity."RoleScope" WHERE NOT (role_id = ANY($1::uuid[]))`, [ROLE_IDS]);
    expect(rs.rows[0].n).toBe(939);
    const roles = await run(`SELECT count(*)::int AS n FROM identity."Role" WHERE NOT (id = ANY($1::uuid[]))`, [ROLE_IDS]);
    expect(roles.rows[0].n).toBe(19);
    const sa = await run(
      `SELECT s.key FROM identity."RoleScope" rs JOIN identity."Scope" s ON s.id = rs.scope_id WHERE rs.role_id = $1 ORDER BY s.key`,
      [SEED_IDS.roles.super_admin],
    );
    expect(sa.rows.map((r) => r.key)).toHaveLength(10);
    for (const k of COMMERCIAL) expect(sa.rows.map((r) => r.key)).not.toContain(k);
    // The unrelated memberships were never bumped.
    const v = await run(`SELECT principal_id, version FROM identity."AuthorizationVersion" WHERE principal_id = ANY($1::uuid[]) ORDER BY 1`, [[recruiter.user_id, superAdmin.user_id]]);
    expect(v.rows).toEqual([{ principal_id: recruiter.user_id, version: 4 }]);
  });

  // ── §8 role revocation between request and approval, at catalog level (NC-4). ─────────
  it('§8 NC-4 — a CCP role granted (test fixture, allow_platform_roles) then removed: the next resolution holds none of its commercial scopes and the version advanced', async () => {
    const versions = new AuthorizationVersionService(prisma);
    const entitlements = { getCapabilities: async () => new Set<string>(['core']) } as unknown as TenantEntitlementReader;
    const resolver = new IdentityEffectiveAuthorizationResolver(
      new RoleService(new RoleRepository(prisma)),
      versions,
      new InMemoryScopeCache(),
      { portalScopes: [], scopeCacheTtlSeconds: 300 },
      entitlements,
    );
    const identitySvc = new IdentityService(
      new IdentityRepository(prisma),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undefined as any,
      new RoleBundleValidator(prisma),
      entitlements,
    );
    const m = await member(SEED_IDS.platform_tenant, []);
    await versions.ensureBaseline(prisma, { tenant_id: m.tenant_id, principal_id: m.user_id });
    const input = (v: number, consumer_type: 'platform' | 'recruiter' = 'platform') =>
      ({ tenant_id: m.tenant_id, principal_id: m.user_id, token_authz_version: v, consumer_type, actor_kind: 'user' }) as const;

    await identitySvc.replaceMembershipRoles({
      membership_id: m.membership_id,
      tenant_id: m.tenant_id,
      role_keys: ['finance_admin'],
      role_ids: [SEED_IDS.roles.finance_admin],
      request_id: 'req-ccp-a1-nc4',
      allow_platform_roles: true,
    });
    const v1 = await versions.getCurrentVersion({ tenant_id: m.tenant_id, principal_id: m.user_id });
    const held = await resolver.resolve(input(v1));
    expect(held.status).toBe('ok');
    const finance = [...(CCP_PLATFORM_ROLE_SEED_BUNDLES.find(([r]) => r === 'finance_admin')?.[1] ?? [])].sort();
    if (held.status === 'ok') expect([...held.scopes].sort()).toEqual(finance);
    // The same principal on a tenant consumer carries none of them (§7.3(e) at runtime).
    const asRecruiter = await resolver.resolve(input(v1, 'recruiter'));
    if (asRecruiter.status === 'ok') for (const s of COMMERCIAL) expect(asRecruiter.scopes).not.toContain(s);

    await identitySvc.replaceMembershipRoles({
      membership_id: m.membership_id,
      tenant_id: m.tenant_id,
      role_keys: [],
      role_ids: [],
      request_id: 'req-ccp-a1-nc4-revoke',
      allow_platform_roles: true,
    });
    const v2 = await versions.getCurrentVersion({ tenant_id: m.tenant_id, principal_id: m.user_id });
    expect(v2).toBeGreaterThan(v1);
    expect((await resolver.resolve(input(v1))).status).toBe('stale');
    const after = await resolver.resolve(input(v2));
    expect(after.status).toBe('ok');
    if (after.status === 'ok') for (const s of COMMERCIAL) expect(after.scopes).not.toContain(s);
  });
});
