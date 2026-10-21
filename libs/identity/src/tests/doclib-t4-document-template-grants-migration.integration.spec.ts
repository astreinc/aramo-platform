import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SEED_IDS, doclibT4RoleScopeId, runIdentitySeed } from '../../prisma/seed.js';

// DOC-TEMPLATE-LIB-1 T-4 — Implementation Directive v1.0 (LOCKED) §6.3 on real Postgres.
//   1. fresh database: identity migrations (the T-4 block is a no-op without a role
//      catalog) + the seed, which writes the T-4 model directly — its bundles are the
//      reference;
//   2. the catalog is rewound to the pre-T-4 state (row 0010 ats_admin holding
//      document_template:manage under its fixed seed id, sign_admin / sign_sender without
//      document_template:read);
//   3. memberships whose effective sets do / do not change;
// then the migration: bundles equal the fresh-seed model, versions bumped exactly for the
// changed principals, a re-run is a no-op, a seed re-run changes nothing, and a database
// without the ROLES-1 role model is refused with nothing applied.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = 'libs/identity/prisma/migrations/20261021150000_doclib_t4_document_template_grants/migration.sql';
const R = {
  owner: SEED_IDS.roles.tenant_owner,
  ats: SEED_IDS.roles.ats_admin,
  org: SEED_IDS.roles.tenant_admin,
  sadm: SEED_IDS.roles.sign_admin,
  ssnd: SEED_IDS.roles.sign_sender,
  recruiter: SEED_IDS.roles.recruiter,
};
const RETIRED_ATS_MANAGE_ID = '01900000-0000-7000-8000-000000001311';

type Member = { tenant_id: string; user_id: string; membership_id: string };

describe('DOC-TEMPLATE-LIB-1 T-4 — document_template grants migration (real PG)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  const notices: string[] = [];
  let seedSets: Record<string, Set<string>>;
  let atsOnly: Member, atsAndAdmin: Member, owner: Member, sender: Member, senderRecruiter: Member, signAdmin: Member;

  const run = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const applyMigration = () => run(readFileSync(resolve(ROOT, MIGRATION), 'utf8'));

  async function roleScopeKeys(role_id: string): Promise<Set<string>> {
    const r = await run(
      `SELECT s.key FROM identity."RoleScope" rs JOIN identity."Scope" s ON s.id = rs.scope_id WHERE rs.role_id = $1`,
      [role_id],
    );
    return new Set(r.rows.map((x) => x.key as string));
  }
  async function member(tenant_id: string, roles: string[]): Promise<Member> {
    const user_id = uuidv7();
    const membership_id = uuidv7();
    await run(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `t4-${user_id}@acme.test`, tenant_id]);
    await run(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [membership_id, user_id, tenant_id]);
    for (const role_id of roles) {
      await run(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), membership_id, role_id]);
    }
    return { tenant_id, user_id, membership_id };
  }
  async function snapshot(): Promise<string> {
    const parts = await Promise.all([
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
    seedSets = {};
    for (const [k, id] of Object.entries(R)) seedSets[k] = await roleScopeKeys(id);

    // ── Rewind to the pre-T-4 catalog. ─────────────────────────────────────────
    await run(
      `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT $1, $2, id FROM identity."Scope" WHERE key = 'document_template:manage'`,
      [RETIRED_ATS_MANAGE_ID, R.ats],
    );
    await run(
      `DELETE FROM identity."RoleScope" WHERE role_id = ANY($1::uuid[]) AND scope_id IN (SELECT id FROM identity."Scope" WHERE key = 'document_template:read')`,
      [[R.sadm, R.ssnd]],
    );

    const t = uuidv7();
    await run(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, $2, 'ACTIVE', now())`, [t, `T4 ${t}`]);
    owner = await member(t, [R.owner]);
    atsOnly = await member(t, [R.ats]);
    atsAndAdmin = await member(t, [R.ats, R.org]);
    sender = await member(t, [R.ssnd]);
    senderRecruiter = await member(t, [R.ssnd, R.recruiter]);
    signAdmin = await member(t, [R.sadm]);
    await run(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES ($1, $2, $3, 5, now())`, [uuidv7(), t, signAdmin.user_id]);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('registration — appended after the ROLES-1 role model it depends on', () => {
    expect(IDENTITY_MIGRATIONS).toContain(MIGRATION);
    expect(IDENTITY_MIGRATIONS.indexOf(MIGRATION)).toBeGreaterThan(
      IDENTITY_MIGRATIONS.indexOf('libs/identity/prisma/migrations/20261021130000_roles1_role_model/migration.sql'),
    );
  });

  it('fresh database — the block ran as a no-op and the seed wrote the T-4 model directly', () => {
    expect(notices.some((n) => n.includes('doclib_t4: no role catalog'))).toBe(true);
    expect(seedSets['ats']?.has('document_template:manage')).toBe(false);
    expect(seedSets['ats']?.has('document_template:read')).toBe(true);
    for (const k of ['owner', 'org']) {
      expect(seedSets[k]?.has('document_template:read')).toBe(true);
      expect(seedSets[k]?.has('document_template:manage')).toBe(true);
    }
    for (const k of ['sadm', 'ssnd']) {
      expect(seedSets[k]?.has('document_template:read')).toBe(true);
      expect(seedSets[k]?.has('document_template:manage')).toBe(false);
    }
    // T-4 does not remove sign:template:*; T-5 does (seed + 20261021160000 migration).
    expect(seedSets['sadm']?.has('sign:template:manage')).toBe(false);
  });

  it('refuses a database without the ROLES-1 role model — nothing applied', async () => {
    await run(`UPDATE identity."Role" SET key = 'tenant_admin_pre' WHERE id = $1`, [R.ats]);
    const before = await snapshot();
    await expect(applyMigration()).rejects.toThrow(/doclib_t4: unexpected role state refused/);
    expect(await snapshot()).toBe(before);
    await run(`UPDATE identity."Role" SET key = 'ats_admin' WHERE id = $1`, [R.ats]);
  });

  it('applies — bundles equal the fresh-seed model; ids are the seed-identical deterministic ones', async () => {
    notices.length = 0;
    await applyMigration();
    const sorted = (s: Set<string> | undefined) => [...(s ?? [])].sort();
    for (const k of ['ats', 'org', 'owner', 'sadm', 'ssnd', 'recruiter'] as const) {
      expect(sorted(await roleScopeKeys(R[k])), k).toEqual(sorted(seedSets[k]));
    }
    expect((await run(`SELECT count(*)::int AS n FROM identity."RoleScope" WHERE id = $1`, [RETIRED_ATS_MANAGE_ID])).rows[0].n).toBe(0);
    const readScope = SEED_IDS.scopes['document_template:read'];
    for (const role_id of [R.sadm, R.ssnd]) {
      const row = await run(`SELECT id FROM identity."RoleScope" WHERE role_id = $1 AND scope_id = $2`, [role_id, readScope]);
      expect(row.rows[0].id).toBe(doclibT4RoleScopeId(role_id, readScope));
    }
    expect(notices.some((n) => n.includes('document_template grants inserted: 2'))).toBe(true);
    expect(notices.some((n) => n.includes('ats_admin document_template:manage grants removed: 1'))).toBe(true);
  });

  it('AuthorizationVersion — bumped exactly for the principals whose effective scope set changed', async () => {
    expect(await version(atsOnly)).toBe(2); // loses document_template:manage
    expect(await version(sender)).toBe(2); // gains document_template:read
    expect(await version(signAdmin)).toBe(6); // gains document_template:read (existing row +1)
    // Unchanged effective sets → no bump.
    expect(await version(atsAndAdmin)).toBeNull(); // keeps manage via tenant_admin
    expect(await version(owner)).toBeNull();
    expect(await version(senderRecruiter)).toBeNull(); // already read via recruiter
  });

  it('idempotent — a re-run changes nothing and bumps nobody', async () => {
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(notices.some((n) => n.includes('authorization versions bumped: 0'))).toBe(true);
  });

  it('the seed re-run on the migrated database changes nothing (migrate, then seed)', async () => {
    const before = await snapshot();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    expect(await snapshot()).toBe(before);
  });
});
