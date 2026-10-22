import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SEED_IDS, atsQa1RoleScopeId, roles1RoleScopeId, runIdentitySeed } from '../../prisma/seed.js';

// ATS-QA-1 — Package 1 Implementation Directive v1.0 (LOCKED) §4 I-2 + conforming amendment A4
// on real Postgres: pipeline:resume:set is granted to every pipeline:add role.
//   1. fresh database: identity migrations (the block is a no-op without a role catalog) + the
//      seed, which writes the A4 model directly — its bundles are the reference;
//   2. rewound to the I-0 production state (finding F-1): NO pipeline:resume:set Scope row and
//      therefore no grants at all;
//   3. memberships whose effective sets do / do not change;
// then the migration: the Scope row is restored on its seed id with the seed's description,
// every grant carries the seed-identical id, versions are bumped exactly for the changed
// principals, a re-run is a no-op, a seed re-run changes nothing, and an unexpected role
// model is refused with nothing applied.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = 'libs/identity/prisma/migrations/20261022150000_ats_qa_1_resume_select_grants/migration.sql';
const SCOPE_ID = SEED_IDS.scopes['pipeline:resume:set'];
const R = {
  ats: SEED_IDS.roles.ats_admin,
  owner: SEED_IDS.roles.tenant_owner,
  recruiter: SEED_IDS.roles.recruiter,
  am: SEED_IDS.roles.account_manager,
  org: SEED_IDS.roles.tenant_admin,
  lr: SEED_IDS.roles.lead_recruiter,
  rm: SEED_IDS.roles.recruiting_manager,
  src: SEED_IDS.roles.sourcer,
};
const EXPECTED_IDS: Record<keyof typeof R, string> = {
  ats: '01900000-0000-7000-8000-000000001200',
  owner: '01900000-0000-7000-8000-000000001201',
  recruiter: '01900000-0000-7000-8000-000000001202',
  am: '01900000-0000-7000-8000-000000001203',
  org: roles1RoleScopeId(R.org, SCOPE_ID),
  lr: atsQa1RoleScopeId(R.lr, SCOPE_ID),
  rm: atsQa1RoleScopeId(R.rm, SCOPE_ID),
  src: atsQa1RoleScopeId(R.src, SCOPE_ID),
};

type Member = { tenant_id: string; user_id: string };

describe('ATS-QA-1 — pipeline:resume:set for every pipeline:add role (real PG)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  const notices: string[] = [];
  let seedScope: { id: string; description: string };
  let seedHolders: string[];
  let recruiter: Member, src: Member, lr: Member, superAdmin: Member;

  const run = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const applyMigration = () => run(readFileSync(resolve(ROOT, MIGRATION), 'utf8'));

  async function holders(): Promise<string[]> {
    const r = await run(
      `SELECT ro.key FROM identity."RoleScope" rs JOIN identity."Role" ro ON ro.id = rs.role_id
        JOIN identity."Scope" s ON s.id = rs.scope_id WHERE s.key = 'pipeline:resume:set' ORDER BY ro.key`,
    );
    return r.rows.map((x) => x.key as string);
  }
  async function member(tenant_id: string, roles: string[]): Promise<Member> {
    const user_id = uuidv7();
    const membership_id = uuidv7();
    await run(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `qa1-${user_id}@acme.test`, tenant_id]);
    await run(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [membership_id, user_id, tenant_id]);
    for (const role_id of roles) {
      await run(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), membership_id, role_id]);
    }
    return { tenant_id, user_id };
  }
  async function snapshot(): Promise<string> {
    const parts = await Promise.all([
      run(`SELECT id, key, description FROM identity."Scope" ORDER BY id`),
      run(`SELECT id, key, description, is_active FROM identity."Role" ORDER BY id`),
      run(`SELECT id, role_id, scope_id FROM identity."RoleScope" ORDER BY id`),
      run(`SELECT tenant_id, principal_id, version FROM identity."AuthorizationVersion" ORDER BY tenant_id, principal_id`),
    ]);
    return JSON.stringify(parts.map((p) => p.rows));
  }
  async function version(m: Member): Promise<number | null> {
    const r = await run(`SELECT version FROM identity."AuthorizationVersion" WHERE tenant_id = $1 AND principal_id = $2`, [m.tenant_id, m.user_id]);
    return r.rows[0]?.version ?? null;
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    db.on('notice', (n) => notices.push(n.message ?? ''));
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    seedHolders = await holders();
    seedScope = (await run(`SELECT id, description FROM identity."Scope" WHERE key = 'pipeline:resume:set'`)).rows[0];

    // ── Rewind to the I-0 production state (F-1): no Scope row, no grants. ─────────
    await run(`DELETE FROM identity."RoleScope" WHERE scope_id = $1`, [SCOPE_ID]);
    await run(`DELETE FROM identity."Scope" WHERE id = $1`, [SCOPE_ID]);

    const t = uuidv7();
    await run(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, $2, 'ACTIVE', now())`, [t, `QA1 ${t}`]);
    recruiter = await member(t, [R.recruiter]);
    src = await member(t, [R.src]);
    lr = await member(t, [R.lr]);
    superAdmin = await member(t, [SEED_IDS.roles.super_admin]);
    await run(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES ($1, $2, $3, 5, now())`, [uuidv7(), t, lr.user_id]);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('registration — appended after the ROLES-1 role model and ORG-UX-1', () => {
    expect(IDENTITY_MIGRATIONS).toContain(MIGRATION);
    for (const dep of [
      'libs/identity/prisma/migrations/20261021130000_roles1_role_model/migration.sql',
      'libs/identity/prisma/migrations/20261022140000_org_ux_1_template_author_grants/migration.sql',
    ]) {
      expect(IDENTITY_MIGRATIONS.indexOf(MIGRATION)).toBeGreaterThan(IDENTITY_MIGRATIONS.indexOf(dep));
    }
  });

  it('fresh database — the block ran as a no-op and the seed wrote the A4 model (every pipeline:add role)', () => {
    expect(notices.some((n) => n.includes('ats_qa_1: no role catalog'))).toBe(true);
    expect(seedHolders).toEqual(
      ['account_manager', 'ats_admin', 'lead_recruiter', 'recruiter', 'recruiting_manager', 'sourcer', 'tenant_admin', 'tenant_owner'],
    );
    expect(seedScope.id).toBe(SCOPE_ID);
  });

  it('every pipeline:add holder holds pipeline:resume:set in the seed model (no new talent:search)', async () => {
    const add = await run(
      `SELECT ro.key FROM identity."RoleScope" rs JOIN identity."Role" ro ON ro.id = rs.role_id AND ro.is_active
        JOIN identity."Scope" s ON s.id = rs.scope_id WHERE s.key = 'pipeline:add' ORDER BY ro.key`,
    );
    expect(add.rows.map((x) => x.key)).toEqual(seedHolders);
  });

  it('refuses an unexpected role model — nothing applied', async () => {
    await run(`UPDATE identity."Role" SET key = 'org_admin' WHERE id = $1`, [R.org]);
    const before = await snapshot();
    await expect(applyMigration()).rejects.toThrow(/ats_qa_1: unexpected role state refused/);
    expect(await snapshot()).toBe(before);
    await run(`UPDATE identity."Role" SET key = 'tenant_admin' WHERE id = $1`, [R.org]);
  });

  it('applies on the F-1 state — Scope row restored seed-identically; grants carry the seed ids', async () => {
    notices.length = 0;
    await applyMigration();
    const scope = await run(`SELECT id, description FROM identity."Scope" WHERE key = 'pipeline:resume:set'`);
    expect(scope.rows[0]).toEqual(seedScope);
    expect(await holders()).toEqual(seedHolders);
    for (const k of Object.keys(R) as (keyof typeof R)[]) {
      const row = await run(`SELECT id FROM identity."RoleScope" WHERE role_id = $1 AND scope_id = $2`, [R[k], SCOPE_ID]);
      expect(row.rows[0]?.id, k).toBe(EXPECTED_IDS[k]);
    }
    expect(notices.some((n) => n.includes('pipeline:resume:set grants inserted: 8'))).toBe(true);
  });

  it('AuthorizationVersion — bumped exactly for the principals whose effective scope set changed', async () => {
    expect(await version(recruiter)).toBe(2);
    expect(await version(src)).toBe(2);
    expect(await version(lr)).toBe(6); // existing row +1
    expect(await version(superAdmin)).toBeNull(); // unchanged
  });

  it('idempotent — a re-run changes nothing and bumps nobody', async () => {
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(notices.some((n) => n.includes('grants inserted: 0'))).toBe(true);
    expect(notices.some((n) => n.includes('authorization versions bumped: 0'))).toBe(true);
  });

  it('the seed re-run on the migrated database changes nothing (migrate, then seed)', async () => {
    const before = await snapshot();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    expect(await snapshot()).toBe(before);
  });
});
