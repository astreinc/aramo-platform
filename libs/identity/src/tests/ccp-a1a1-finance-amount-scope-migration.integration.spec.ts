import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import {
  CCP_A1A1_FINANCE_AMOUNT_HOLDERS,
  CCP_A1A1_FINANCE_AMOUNT_SCOPE,
  CCP_A1A1_FINANCE_AMOUNT_SCOPE_DESCRIPTION,
  SEED_IDS,
  ccpA1A1RoleScopeId,
  runIdentitySeed,
} from '../../prisma/seed.js';

// CCP-R3 — Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 (LOCKED 2026-10-25) FA-2, FA-7,
// FA-8 on real Postgres 17: the 20261028060000 migration and its compensating SQL.
//   1. fresh database: identity migrations (the block is a no-op without a role catalog) + the
//      seed, which writes the scope and the 3 grants with the md5 ccp-a1a1 ids;
//   2. migrate after seed: nothing inserted, nobody bumped;
//   3. rewound to the pre-amendment state with live memberships: the migration ensures the
//      seed-identical rows and bumps exactly the principals whose effective set changed;
//   4. idempotent re-run; seed after migration converges;
//   5. fail-closed fixtures RAISE and apply nothing;
//   6. the compensation refuses while another role holds the scope, then removes the 3 grants
//      and the scope and bumps the holders; the migration re-applies.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = 'libs/identity/prisma/migrations/20261028060000_ccp_a1a1_finance_amount_scope/migration.sql';
const COMPENSATION = resolve(__dirname, 'fixtures/ccp-a1a1-compensating.sql');
const SCOPE_ID = SEED_IDS.scopes['platform:billing:amount:read'];
const HOLDER_IDS = CCP_A1A1_FINANCE_AMOUNT_HOLDERS.map((k) => SEED_IDS.roles[k]);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('CCP-A1 Amendment A1 — Finance amount scope migration (real PG)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  const notices: string[] = [];
  let seedModel: string;
  let t: string;
  let owner: { user_id: string; membership_id: string };
  let ops: { user_id: string; membership_id: string };

  const run = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const migrationSql = () => readFileSync(resolve(ROOT, MIGRATION), 'utf8');
  const applyMigration = () => run(migrationSql());
  const lastNotice = (re: RegExp) => notices.some((n) => re.test(n));

  async function model(): Promise<string> {
    const parts = await Promise.all([
      run(`SELECT id, key, description FROM identity."Scope" WHERE id = $1 OR key = $2 ORDER BY id`, [SCOPE_ID, CCP_A1A1_FINANCE_AMOUNT_SCOPE]),
      run(`SELECT id, role_id, scope_id FROM identity."RoleScope" WHERE scope_id = $1 ORDER BY id`, [SCOPE_ID]),
    ]);
    return JSON.stringify(parts.map((p) => p.rows));
  }
  async function snapshot(): Promise<string> {
    const parts = await Promise.all([
      run(`SELECT id, key, description FROM identity."Scope" ORDER BY id`),
      run(`SELECT id, role_id, scope_id FROM identity."RoleScope" ORDER BY id`),
      run(`SELECT tenant_id, principal_id, version FROM identity."AuthorizationVersion" ORDER BY tenant_id, principal_id`),
    ]);
    return JSON.stringify(parts.map((p) => p.rows));
  }
  const version = async (user_id: string): Promise<number | null> =>
    ((await run(`SELECT version FROM identity."AuthorizationVersion" WHERE tenant_id = $1 AND principal_id = $2`, [t, user_id])).rows[0]?.version as number | undefined) ?? null;
  async function member(roles: string[]): Promise<{ user_id: string; membership_id: string }> {
    const user_id = uuidv7();
    const membership_id = uuidv7();
    await run(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `ccpa1a1-${user_id}@ops.test`, t]);
    await run(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [membership_id, user_id, t]);
    for (const role_id of roles) await run(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), membership_id, role_id]);
    return { user_id, membership_id };
  }
  const effective = async (user_id: string): Promise<string[]> =>
    (
      await run(
        `SELECT DISTINCT s.key FROM identity."UserTenantMembership" m JOIN identity."UserTenantMembershipRole" r ON r.membership_id = m.id
           JOIN identity."RoleScope" rs ON rs.role_id = r.role_id JOIN identity."Scope" s ON s.id = rs.scope_id WHERE m.user_id = $1 ORDER BY 1`,
        [user_id],
      )
    ).rows.map((r) => r.key as string);

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    db.on('notice', (n) => notices.push(n.message ?? ''));
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    seedModel = await model();
    t = uuidv7();
    await run(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, 'A1A1 tenant', 'ACTIVE', now())`, [t]);
    owner = await member([SEED_IDS.roles.platform_owner]);
    ops = await member([SEED_IDS.roles.commercial_ops]);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  });

  it('A1A1-M-0 registration — after CCP-A9, followed by the CCP-A1 Amendment A2 payment request scope (then only M-A7 privacy requests); one statement, no $$', () => {
    expect(IDENTITY_MIGRATIONS.at(-3)).toBe(MIGRATION);
    expect(IDENTITY_MIGRATIONS.at(-2)).toBe('libs/identity/prisma/migrations/20261028070000_ccp_a1a2_payment_request_scope/migration.sql');
    expect(IDENTITY_MIGRATIONS.at(-1)).toBe('libs/identity/prisma/migrations/20261030030000_privacy_requests/migration.sql');
    expect(IDENTITY_MIGRATIONS.at(-4)).toBe('libs/identity/prisma/migrations/20261025180000_ccp_a9_platform_last_owner_invariant/migration.sql');
    const sql = migrationSql();
    expect(sql).not.toContain('$$');
    expect(sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/).map((x) => x.trim()).filter((x) => x.length > 0)).toHaveLength(1);
  });

  it('A1A1-M-1 fresh database — the block ran as a no-op; the seed wrote the scope (0x335, seed text) and exactly 3 grants with the md5 ccp-a1a1 ids', async () => {
    expect(lastNotice(/ccp_a1a1: no role catalog yet/)).toBe(true);
    const sc = (await run(`SELECT id, key, description FROM identity."Scope" WHERE key = $1`, [CCP_A1A1_FINANCE_AMOUNT_SCOPE])).rows;
    expect(sc).toEqual([{ id: SCOPE_ID, key: CCP_A1A1_FINANCE_AMOUNT_SCOPE, description: CCP_A1A1_FINANCE_AMOUNT_SCOPE_DESCRIPTION }]);
    const rs = (await run(`SELECT id, role_id FROM identity."RoleScope" WHERE scope_id = $1 ORDER BY role_id`, [SCOPE_ID])).rows;
    expect(rs.map((r) => r.role_id).sort()).toEqual([...HOLDER_IDS].sort());
    for (const r of rs) expect(r.id).toBe(ccpA1A1RoleScopeId(r.role_id as string, SCOPE_ID));
  });

  it('A1A1-M-2 migration after seed — inserts 0 / 0, bumps nobody, changes nothing', async () => {
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(lastNotice(/ccp_a1a1: scopes inserted: 0, grants inserted: 0, authorization versions bumped: 0/)).toBe(true);
  });

  it('A1A1-M-3 pre-amendment state with live memberships — ensures the seed-identical rows; bumps exactly the platform_owner holder (not commercial_ops); the holder now resolves the scope', async () => {
    await run(`DELETE FROM identity."RoleScope" WHERE scope_id = $1`, [SCOPE_ID]);
    await run(`DELETE FROM identity."Scope" WHERE id = $1`, [SCOPE_ID]);
    expect(await effective(owner.user_id)).not.toContain(CCP_A1A1_FINANCE_AMOUNT_SCOPE);
    const opsBefore = await version(ops.user_id);
    notices.length = 0;
    await applyMigration();
    expect(await model()).toBe(seedModel);
    expect(lastNotice(/ccp_a1a1: scopes inserted: 1, grants inserted: 3, authorization versions bumped: 1/)).toBe(true);
    expect(await version(owner.user_id)).toBe(2);
    expect(await version(ops.user_id)).toBe(opsBefore);
    expect(await effective(owner.user_id)).toContain(CCP_A1A1_FINANCE_AMOUNT_SCOPE);
    expect(await effective(ops.user_id)).not.toContain(CCP_A1A1_FINANCE_AMOUNT_SCOPE);
  });

  it('A1A1-M-4 idempotent — a re-run inserts 0 rows and bumps 0; a seed re-run changes nothing', async () => {
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(lastNotice(/ccp_a1a1: scopes inserted: 0, grants inserted: 0, authorization versions bumped: 0/)).toBe(true);
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    expect(await snapshot()).toBe(before);
  });

  describe('A1A1-M-5 fail closed — RAISE and apply nothing', () => {
    async function refused(re: RegExp): Promise<void> {
      const before = await snapshot();
      await expect(applyMigration()).rejects.toThrow(re);
      expect(await snapshot()).toBe(before);
    }
    it('a fourth holder (commercial_ops granted the scope, FA-2)', async () => {
      const extra = uuidv7();
      await run(`INSERT INTO identity."RoleScope" (id, role_id, scope_id) VALUES ($1, $2, $3)`, [extra, SEED_IDS.roles.commercial_ops, SCOPE_ID]);
      await refused(/ccp_a1a1: the holders of platform:billing:amount:read differ from FA-2 \(exactly 3 roles\), refused/);
      await run(`DELETE FROM identity."RoleScope" WHERE id = $1`, [extra]);
    });
    it('the scope id holding a different key', async () => {
      await run(`UPDATE identity."Scope" SET key = 'platform:billing:amount:other' WHERE id = $1`, [SCOPE_ID]);
      await refused(/ccp_a1a1: scope id\/key conflict refused/);
      await run(`UPDATE identity."Scope" SET key = $2 WHERE id = $1`, [SCOPE_ID, CCP_A1A1_FINANCE_AMOUNT_SCOPE]);
    });
    it('a scope description that differs from the seed definition', async () => {
      await run(`UPDATE identity."Scope" SET description = 'edited' WHERE id = $1`, [SCOPE_ID]);
      await refused(/ccp_a1a1: scope row differs from the seed definition, refused/);
      await run(`UPDATE identity."Scope" SET description = $2 WHERE id = $1`, [SCOPE_ID, CCP_A1A1_FINANCE_AMOUNT_SCOPE_DESCRIPTION]);
      expect(await model()).toBe(seedModel);
    });
  });

  it('A1A1-M-6 (FA-8) the compensation refuses while another role holds the scope; then removes the 3 grants and the scope, bumps the holder; the migration re-applies to the seed model', async () => {
    const compensation = readFileSync(COMPENSATION, 'utf8');
    const extra = uuidv7();
    await run(`INSERT INTO identity."RoleScope" (id, role_id, scope_id) VALUES ($1, $2, $3)`, [extra, SEED_IDS.roles.support_admin, SCOPE_ID]);
    const before = await snapshot();
    await expect(run(`BEGIN; ${compensation} COMMIT;`)).rejects.toThrow(/CCP-A1-A1 compensation refused: a role other than the 3 grantees holds platform:billing:amount:read/);
    await run('ROLLBACK');
    expect(await snapshot()).toBe(before);
    await run(`DELETE FROM identity."RoleScope" WHERE id = $1`, [extra]);
    const v = await version(owner.user_id);
    await run(`BEGIN; ${compensation} COMMIT;`);
    expect((await run(`SELECT count(*)::int n FROM identity."RoleScope" WHERE scope_id = $1`, [SCOPE_ID])).rows[0].n).toBe(0);
    expect((await run(`SELECT count(*)::int n FROM identity."Scope" WHERE id = $1`, [SCOPE_ID])).rows[0].n).toBe(0);
    expect(await version(owner.user_id)).toBe((v ?? 1) + 1);
    expect(await effective(owner.user_id)).not.toContain(CCP_A1A1_FINANCE_AMOUNT_SCOPE);
    await applyMigration();
    expect(await model()).toBe(seedModel);
  });
});
