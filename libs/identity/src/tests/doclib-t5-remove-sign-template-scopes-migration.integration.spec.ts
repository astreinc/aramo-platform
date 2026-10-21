import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SEED_IDS, runIdentitySeed } from '../../prisma/seed.js';

// DOC-TEMPLATE-LIB-1 T-5 — Implementation Directive v1.0 (LOCKED) §6.4 on real Postgres.
//   1. fresh database: identity migrations (the T-5 block is a no-op: no template scopes)
//      + the seed, which no longer writes sign:template:* — its bundles are the reference;
//   2. the catalog is rewound to the pre-T-5 state an existing database holds: Scope rows
//      0x140d / 0x140e and their 5 grants under the fixed seed ids (sign_owner 0x1723/
//      0x1724 on the retired, INACTIVE row; sign_admin 0x172d/0x172e; sign_sender 0x1734);
//   3. memberships whose effective sets do / do not change;
// then the migration: scope rows + grants gone, bundles equal the fresh seed, versions
// bumped exactly for the changed principals, re-run no-op, seed re-run no-op, and an
// unexpected grant / key is refused with nothing applied.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = 'libs/identity/prisma/migrations/20261021160000_doclib_t5_remove_sign_template_scopes/migration.sql';
const S_USE = '01900000-0000-7000-8000-00000000140d';
const S_MANAGE = '01900000-0000-7000-8000-00000000140e';
const R = {
  sown: '01900000-0000-7000-8000-0000000002a0',
  sadm: SEED_IDS.roles.sign_admin,
  ssnd: SEED_IDS.roles.sign_sender,
  sview: SEED_IDS.roles.sign_viewer,
  owner: SEED_IDS.roles.tenant_owner,
  org: SEED_IDS.roles.tenant_admin,
  recruiter: SEED_IDS.roles.recruiter,
};
const rsId = (n: number) => `01900000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const LEGACY_GRANTS: Array<[string, string, string]> = [
  [rsId(0x1723), R.sown, S_USE],
  [rsId(0x1724), R.sown, S_MANAGE],
  [rsId(0x172d), R.sadm, S_USE],
  [rsId(0x172e), R.sadm, S_MANAGE],
  [rsId(0x1734), R.ssnd, S_USE],
];

type Member = { tenant_id: string; user_id: string };

describe('DOC-TEMPLATE-LIB-1 T-5 — sign:template:* removal migration (real PG)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  const notices: string[] = [];
  let seedSets: Record<string, Set<string>>;
  let sender: Member, signAdmin: Member, legacyOwner: Member, orgOwner: Member, viewer: Member;

  const run = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const applyMigration = () => run(readFileSync(resolve(ROOT, MIGRATION), 'utf8'));

  async function roleScopeKeys(role_id: string): Promise<Set<string>> {
    const r = await run(`SELECT s.key FROM identity."RoleScope" rs JOIN identity."Scope" s ON s.id = rs.scope_id WHERE rs.role_id = $1`, [role_id]);
    return new Set(r.rows.map((x) => x.key as string));
  }
  async function member(tenant_id: string, roles: string[]): Promise<Member> {
    const user_id = uuidv7();
    const membership_id = uuidv7();
    await run(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `t5-${user_id}@acme.test`, tenant_id]);
    await run(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [membership_id, user_id, tenant_id]);
    for (const role_id of roles) {
      await run(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), membership_id, role_id]);
    }
    return { tenant_id, user_id };
  }
  async function snapshot(): Promise<string> {
    const parts = await Promise.all([
      run(`SELECT id, key FROM identity."Scope" ORDER BY id`),
      run(`SELECT id, role_id, scope_id FROM identity."RoleScope" ORDER BY id`),
      run(`SELECT tenant_id, principal_id, version FROM identity."AuthorizationVersion" ORDER BY tenant_id, principal_id`),
    ]);
    return JSON.stringify(parts.map((p) => p.rows));
  }
  async function version(m: Member): Promise<number | null> {
    const r = await run(`SELECT version FROM identity."AuthorizationVersion" WHERE tenant_id = $1 AND principal_id = $2`, [m.tenant_id, m.user_id]);
    return r.rows[0]?.version ?? null;
  }
  async function rewind(): Promise<void> {
    await run(`INSERT INTO identity."Scope" (id, key, description) VALUES ($1, 'sign:template:use', 'Sign S-1'), ($2, 'sign:template:manage', 'Sign S-1') ON CONFLICT DO NOTHING`, [S_USE, S_MANAGE]);
    for (const [id, role_id, scope_id] of LEGACY_GRANTS) {
      await run(`INSERT INTO identity."RoleScope" (id, role_id, scope_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, role_id, scope_id]);
    }
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

    await rewind();
    const t = uuidv7();
    await run(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, $2, 'ACTIVE', now())`, [t, `T5 ${t}`]);
    sender = await member(t, [R.ssnd]);
    signAdmin = await member(t, [R.sadm]);
    legacyOwner = await member(t, [R.sown]);
    orgOwner = await member(t, [R.owner]);
    viewer = await member(t, [R.sview]);
    await run(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES ($1, $2, $3, 5, now())`, [uuidv7(), t, signAdmin.user_id]);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('registration — appended after the T-4 grants migration', () => {
    expect(IDENTITY_MIGRATIONS).toContain(MIGRATION);
    expect(IDENTITY_MIGRATIONS.indexOf(MIGRATION)).toBeGreaterThan(
      IDENTITY_MIGRATIONS.indexOf('libs/identity/prisma/migrations/20261021150000_doclib_t4_document_template_grants/migration.sql'),
    );
  });

  it('fresh database — the block ran as a no-op and the seed writes no sign:template:* scope or grant', async () => {
    expect(notices.some((n) => n.includes('doclib_t5: no sign:template scope rows'))).toBe(true);
    for (const k of Object.keys(R)) {
      expect(seedSets[k]?.has('sign:template:use'), k).toBe(false);
      expect(seedSets[k]?.has('sign:template:manage'), k).toBe(false);
    }
    // Sign keeps template USE through document_template:read (T-4).
    expect(seedSets['sadm']?.has('document_template:read')).toBe(true);
    expect(seedSets['ssnd']?.has('document_template:read')).toBe(true);
  });

  it('the S-1 contract grant ids are unchanged (frozen layout — no renumbering)', async () => {
    const id = async (role_id: string, key: string) =>
      (await run(`SELECT rs.id FROM identity."RoleScope" rs JOIN identity."Scope" s ON s.id = rs.scope_id WHERE rs.role_id = $1 AND s.key = $2`, [role_id, key])).rows[0]?.id;
    expect(await id(R.sadm, 'sign:envelope:read:all')).toBe(rsId(0x172a));
    expect(await id(R.sadm, 'sign:contact:read')).toBe(rsId(0x172c));
    expect(await id(R.sadm, 'sign:report:read')).toBe(rsId(0x172f));
    expect(await id(R.sadm, 'sign:integration:manage')).toBe(rsId(0x1732));
    expect(await id(R.ssnd, 'sign:contact:read')).toBe(rsId(0x1733));
    expect(await id(R.sview, 'sign:envelope:read:all')).toBe(rsId(0x1735));
    expect(await id(R.sview, 'sign:report:read')).toBe(rsId(0x1736));
  });

  it('refuses a grant of a template scope on an unexpected role — nothing applied', async () => {
    const stray = rsId(0x9f001);
    await run(`INSERT INTO identity."RoleScope" (id, role_id, scope_id) VALUES ($1, $2, $3)`, [stray, R.recruiter, S_USE]);
    const before = await snapshot();
    await expect(applyMigration()).rejects.toThrow(/doclib_t5: sign:template grants on unexpected roles refused/);
    expect(await snapshot()).toBe(before);
    await run(`DELETE FROM identity."RoleScope" WHERE id = $1`, [stray]);
  });

  it('refuses a fixed scope id carrying another key — nothing applied', async () => {
    await run(`UPDATE identity."Scope" SET key = 'sign:template:other' WHERE id = $1`, [S_MANAGE]);
    const before = await snapshot();
    await expect(applyMigration()).rejects.toThrow(/doclib_t5: unexpected sign:template scope rows refused/);
    expect(await snapshot()).toBe(before);
    await run(`UPDATE identity."Scope" SET key = 'sign:template:manage' WHERE id = $1`, [S_MANAGE]);
  });

  it('applies — both scope rows and all 5 grants are gone; bundles equal the fresh seed', async () => {
    notices.length = 0;
    await applyMigration();
    expect((await run(`SELECT count(*)::int AS n FROM identity."Scope" WHERE id = ANY($1::uuid[]) OR key LIKE 'sign:template:%'`, [[S_USE, S_MANAGE]])).rows[0].n).toBe(0);
    expect((await run(`SELECT count(*)::int AS n FROM identity."RoleScope" WHERE id = ANY($1::uuid[])`, [LEGACY_GRANTS.map((g) => g[0])])).rows[0].n).toBe(0);
    const sorted = (s: Set<string> | undefined) => [...(s ?? [])].sort();
    for (const k of ['sadm', 'ssnd', 'sview', 'owner', 'org', 'recruiter'] as const) {
      expect(sorted(await roleScopeKeys(R[k])), k).toEqual(sorted(seedSets[k]));
    }
    expect(notices.some((n) => n.includes('sign:template grants removed: 5'))).toBe(true);
    expect(notices.some((n) => n.includes('sign:template scopes removed: 2'))).toBe(true);
  });

  it('AuthorizationVersion — bumped exactly for the principals whose effective scope set changed', async () => {
    expect(await version(sender)).toBe(2); // loses sign:template:use
    expect(await version(signAdmin)).toBe(6); // loses both (existing row +1)
    // Unchanged effective sets → no bump (the retired sign_owner row is inactive).
    expect(await version(legacyOwner)).toBeNull();
    expect(await version(orgOwner)).toBeNull();
    expect(await version(viewer)).toBeNull();
  });

  it('idempotent — a re-run changes nothing and bumps nobody', async () => {
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(notices.some((n) => n.includes('doclib_t5: no sign:template scope rows'))).toBe(true);
  });

  it('the seed re-run on the migrated database changes nothing (migrate, then seed)', async () => {
    const before = await snapshot();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    expect(await snapshot()).toBe(before);
  });
});
