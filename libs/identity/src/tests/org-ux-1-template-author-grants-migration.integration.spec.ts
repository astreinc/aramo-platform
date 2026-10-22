import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { ORG_ADMIN_SCOPE_KEYS } from '../lib/dto/role.dto.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SEED_IDS, orgUx1RoleScopeId, runIdentitySeed } from '../../prisma/seed.js';

// ORG-UX-1 — Implementation Directive v1.0 (LOCKED) §4.1 / §4.2 / §4.3 on real Postgres.
//   1. fresh database: identity migrations (the ORG-UX-1 block is a no-op without a role
//      catalog) + the seed, which writes the ORG-UX-1 model directly — its bundles are the
//      reference;
//   2. the catalog is rewound to the pre-ORG-UX-1 state (no document_template:author scope
//      row or grants; account_manager / recruiting_manager holding tenant:admin:user-manage);
//   3. memberships whose effective sets do / do not change;
// then the migration: bundles equal the fresh-seed model, versions bumped exactly for the
// changed principals, a re-run is a no-op, a seed re-run changes nothing, and a database
// without the ROLES-1 role model is refused with nothing applied.
//
// Lead Correction A invariant: after ORG-UX-1, every organization-management scope is
// held ONLY by the organization roles (tenant_owner / tenant_admin), and billing only by
// tenant_owner — so a template author (or any ATS role) gains no organization administration.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = 'libs/identity/prisma/migrations/20261022140000_org_ux_1_template_author_grants/migration.sql';
const R = {
  owner: SEED_IDS.roles.tenant_owner,
  org: SEED_IDS.roles.tenant_admin,
  am: SEED_IDS.roles.account_manager,
  rm: SEED_IDS.roles.recruiting_manager,
  lr: SEED_IDS.roles.lead_recruiter,
  recruiter: SEED_IDS.roles.recruiter,
  ats: SEED_IDS.roles.ats_admin,
};
const AUTHOR_SCOPE_ID = '01900000-0000-7000-8000-0000000001d9';
const ORG_MANAGEMENT_SCOPES = (ORG_ADMIN_SCOPE_KEYS as readonly string[]).filter(
  (k) => k !== 'tenant:user:read:directory' && k !== 'auth:session:read',
);

type Member = { tenant_id: string; user_id: string; membership_id: string };

describe('ORG-UX-1 — template author grants + management-tier user-manage narrowing (real PG)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  const notices: string[] = [];
  let seedSets: Record<string, Set<string>>;
  let owner: Member, am: Member, rm: Member, lr: Member, recruiter: Member, amAndAdmin: Member;

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
    await run(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `ux1-${user_id}@acme.test`, tenant_id]);
    await run(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, true, now())`, [membership_id, user_id, tenant_id]);
    for (const role_id of roles) {
      await run(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [uuidv7(), membership_id, role_id]);
    }
    return { tenant_id, user_id, membership_id };
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
    seedSets = {};
    for (const [k, id] of Object.entries(R)) seedSets[k] = await roleScopeKeys(id);

    // ── Rewind to the pre-ORG-UX-1 catalog. ────────────────────────────────────
    await run(`DELETE FROM identity."RoleScope" WHERE scope_id = $1`, [AUTHOR_SCOPE_ID]);
    await run(`DELETE FROM identity."Scope" WHERE id = $1`, [AUTHOR_SCOPE_ID]);
    for (const role_id of [R.am, R.rm]) {
      await run(
        `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT $1, $2, id FROM identity."Scope" WHERE key = 'tenant:admin:user-manage'`,
        [uuidv7(), role_id],
      );
    }

    const t = uuidv7();
    await run(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, $2, 'ACTIVE', now())`, [t, `UX1 ${t}`]);
    owner = await member(t, [R.owner]);
    am = await member(t, [R.am]);
    rm = await member(t, [R.rm]);
    lr = await member(t, [R.lr]);
    recruiter = await member(t, [R.recruiter]);
    amAndAdmin = await member(t, [R.am, R.org]);
    await run(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES ($1, $2, $3, 5, now())`, [uuidv7(), t, lr.user_id]);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('registration — appended after the ROLES-1 role model and the DOC-TEMPLATE-LIB-1 grants', () => {
    expect(IDENTITY_MIGRATIONS).toContain(MIGRATION);
    for (const dep of [
      'libs/identity/prisma/migrations/20261021130000_roles1_role_model/migration.sql',
      'libs/identity/prisma/migrations/20261021150000_doclib_t4_document_template_grants/migration.sql',
    ]) {
      expect(IDENTITY_MIGRATIONS.indexOf(MIGRATION)).toBeGreaterThan(IDENTITY_MIGRATIONS.indexOf(dep));
    }
  });

  it('fresh database — the block ran as a no-op and the seed wrote the ORG-UX-1 model directly', () => {
    expect(notices.some((n) => n.includes('org_ux_1: no role catalog'))).toBe(true);
    for (const k of ['owner', 'org', 'am', 'rm', 'lr']) expect(seedSets[k]?.has('document_template:author'), k).toBe(true);
    for (const k of ['recruiter', 'ats']) expect(seedSets[k]?.has('document_template:author'), k).toBe(false);
    for (const k of ['am', 'rm']) expect(seedSets[k]?.has('tenant:admin:user-manage'), k).toBe(false);
    // Approval stays with the organization roles only.
    for (const k of ['am', 'rm', 'lr', 'recruiter', 'ats']) expect(seedSets[k]?.has('document_template:manage'), k).toBe(false);
  });

  it('refuses a database without the ROLES-1 role model — nothing applied', async () => {
    await run(`UPDATE identity."Role" SET key = 'org_admin' WHERE id = $1`, [R.org]);
    const before = await snapshot();
    await expect(applyMigration()).rejects.toThrow(/org_ux_1: unexpected role state refused/);
    expect(await snapshot()).toBe(before);
    await run(`UPDATE identity."Role" SET key = 'tenant_admin' WHERE id = $1`, [R.org]);
  });

  it('applies — the scope row is ensured; bundles equal the fresh-seed model; ids are the seed-identical ones', async () => {
    notices.length = 0;
    await applyMigration();
    const scope = await run(`SELECT id FROM identity."Scope" WHERE key = 'document_template:author'`);
    expect(scope.rows[0].id).toBe(SEED_IDS.scopes['document_template:author']);
    const sorted = (s: Set<string> | undefined) => [...(s ?? [])].sort();
    for (const k of Object.keys(R) as (keyof typeof R)[]) {
      expect(sorted(await roleScopeKeys(R[k])), k).toEqual(sorted(seedSets[k]));
    }
    for (const role_id of [R.owner, R.org, R.am, R.rm, R.lr]) {
      const row = await run(`SELECT id FROM identity."RoleScope" WHERE role_id = $1 AND scope_id = $2`, [role_id, AUTHOR_SCOPE_ID]);
      expect(row.rows[0].id).toBe(orgUx1RoleScopeId(role_id, AUTHOR_SCOPE_ID));
    }
    expect(notices.some((n) => n.includes('document_template:author grants inserted: 5'))).toBe(true);
    expect(notices.some((n) => n.includes('tenant:admin:user-manage grants removed: 2'))).toBe(true);
  });

  it('AuthorizationVersion — bumped exactly for the principals whose effective scope set changed', async () => {
    expect(await version(owner)).toBe(2); // gains author
    expect(await version(am)).toBe(2); // gains author, loses user-manage
    expect(await version(rm)).toBe(2); // gains author, loses user-manage
    expect(await version(lr)).toBe(6); // gains author (existing row +1)
    expect(await version(amAndAdmin)).toBe(2); // gains author (keeps user-manage via tenant_admin)
    expect(await version(recruiter)).toBeNull(); // unchanged
  });

  it('Lead Correction A invariant — organization-management scopes are held only by the organization roles', async () => {
    const r = await run(
      `SELECT DISTINCT s.key AS scope, ro.key AS role FROM identity."RoleScope" rs
         JOIN identity."Scope" s ON s.id = rs.scope_id
         JOIN identity."Role" ro ON ro.id = rs.role_id AND ro.is_active
        WHERE s.key = ANY($1::text[])`,
      [[...ORG_MANAGEMENT_SCOPES, 'document_template:manage', 'sign:billing:manage']],
    );
    for (const row of r.rows as { scope: string; role: string }[]) {
      const allowed = row.scope === 'sign:billing:manage' ? ['tenant_owner'] : ['tenant_owner', 'tenant_admin'];
      expect(allowed, `${row.scope} held by ${row.role}`).toContain(row.role);
    }
    // And every organization-management scope is still held by both organization roles.
    for (const scope of ORG_MANAGEMENT_SCOPES) {
      expect(r.rows.filter((x: { scope: string }) => x.scope === scope).map((x: { role: string }) => x.role).sort(), scope).toEqual([
        'tenant_admin',
        'tenant_owner',
      ]);
    }
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
