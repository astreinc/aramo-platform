import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { ORG_ADMIN_SCOPE_KEYS } from '../lib/dto/role.dto.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';
import { SEED_IDS, runIdentitySeed, roles1RoleScopeId } from '../../prisma/seed.js';

// ROLES-1 PR-2 — Aramo-ROLES-1 Implementation Directive v1.0 (LOCKED) §5.2 / §5.3, on real
// Postgres. The fixture reproduces production's PRE-ROLES-1 shape:
//   1. a fresh database gets the identity migrations (the reconciliation is a no-op on an
//      empty catalog) and the NEW seed (the target model) — its per-role bundles are the
//      reference;
//   2. the catalog is rewound to the pre-ROLES-1 model (row 0010 = tenant_admin with the
//      six organization scopes, row 02b0 = org_admin holding only the org set,
//      tenant_owner without Sign scopes, sign_owner active) plus one EXTRA grant on rows
//      0010 / 0014 that the seed does not know (production carries migration-shipped
//      grants beyond the seed simulation, so the migration must work relationally);
//   3. tenants + memberships: an Astre-like ACTIVE tenant (one owner holding
//      org_admin + tenant_admin + tenant_owner + sign_owner + sign_admin + sourcer, plus a
//      sign_sender and a sign_viewer user), a PROVISIONED Sign-only tenant whose single
//      org_admin is the provisioned owner, a tenant where a sign_owner holder is NOT the
//      owner, a tenant with an old-tenant_admin holder (D-1), an ambiguous ownerless
//      tenant (two org_admins) and the PROVISIONED ownerless platform sentinel.
// Then the migration: fails closed on the ambiguous tenant (nothing applied), refuses a
// resolution row naming a non-member, succeeds once the resolution row is filed, and a
// re-run is a no-op.

const ROOT = resolve(__dirname, '../../../..');
const MIGRATION = 'libs/identity/prisma/migrations/20261021130000_roles1_role_model/migration.sql';
const R = {
  owner: '01900000-0000-7000-8000-000000000014',
  ats: '01900000-0000-7000-8000-000000000010',
  org: '01900000-0000-7000-8000-0000000002b0',
  sown: '01900000-0000-7000-8000-0000000002a0',
  sadm: '01900000-0000-7000-8000-0000000002a1',
  ssnd: '01900000-0000-7000-8000-0000000002a2',
  svwr: '01900000-0000-7000-8000-0000000002a3',
  recruiter: SEED_IDS.roles.recruiter,
  sourcer: SEED_IDS.roles.sourcer,
};
const SIX_ORG_WIDE = [
  'tenant:admin:profile',
  'tenant:admin:domain',
  'tenant:admin:sites',
  'tenant:admin:user-manage',
  'tenant:admin:settings',
  'audit:read',
];
const EXTRA_SCOPE_KEY = 'roles1:test:prod-only';

type Member = { tenant_id: string; user_id: string; membership_id: string };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ROLES-1 PR-2 role model reconciliation migration (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let prisma: PrismaService;
  const notices: string[] = [];
  let seedSets: Record<string, Set<string>>;

  // Fixture handles.
  let tA: string; // Astre-like ACTIVE tenant
  let tB: string; // PROVISIONED Sign-only tenant (single org_admin owner)
  let tC: string; // ACTIVE: sign_owner holder without tenant_owner
  let tD: string; // ACTIVE: old tenant_admin holder (D-1)
  let tE: string; // ACTIVE: ambiguous (two org_admins, no owner)
  let aOwner: Member, aSender: Member, aViewer: Member;
  let bOwner: Member;
  let cOwner: Member, cSignOwner: Member;
  let dOwner: Member, dAdmin: Member;
  let e1: Member, e2: Member;

  const run = (sql: string, params: unknown[] = []) => db.query(sql, params);
  const applyMigration = () => run(readFileSync(resolve(ROOT, MIGRATION), 'utf8'));

  async function roleScopeKeys(role_id: string): Promise<Set<string>> {
    const r = await run(
      `SELECT s.key FROM identity."RoleScope" rs JOIN identity."Scope" s ON s.id = rs.scope_id WHERE rs.role_id = $1`,
      [role_id],
    );
    return new Set(r.rows.map((x) => x.key as string));
  }
  async function roleKeysOf(m: Member): Promise<string[]> {
    const r = await run(
      `SELECT ro.key FROM identity."UserTenantMembershipRole" r JOIN identity."Role" ro ON ro.id = r.role_id WHERE r.membership_id = $1 ORDER BY ro.key`,
      [m.membership_id],
    );
    return r.rows.map((x) => x.key as string);
  }
  async function tenant(status: 'ACTIVE' | 'PROVISIONED'): Promise<string> {
    const id = uuidv7();
    await run(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, $2, $3, now())`, [id, `R1 ${id}`, status]);
    return id;
  }
  async function member(tenant_id: string, roles: string[]): Promise<Member> {
    const user_id = uuidv7();
    const membership_id = uuidv7();
    await run(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `u-${user_id}@acme.test`, tenant_id]);
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
      run(`SELECT id, membership_id, role_id FROM identity."UserTenantMembershipRole" ORDER BY id`),
      run(`SELECT id, event_type, event_payload FROM identity."IdentityAuditEvent" ORDER BY id`),
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
    // The NEW seed = the target model (catalog only).
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    seedSets = {};
    for (const [k, id] of Object.entries(R)) seedSets[k] = await roleScopeKeys(id);

    // ── Rewind the catalog to the pre-ROLES-1 model. ────────────────────────────
    await run(`UPDATE identity."Role" SET key = 'org_admin', description = 'Organization Admin — pre', updated_at = now() WHERE id = $1`, [R.org]);
    await run(`UPDATE identity."Role" SET key = 'tenant_admin', description = 'Tenant Admin — pre', updated_at = now() WHERE id = $1`, [R.ats]);
    await run(`UPDATE identity."Role" SET is_active = true, updated_at = now() WHERE id = $1`, [R.sown]);
    await run(
      `DELETE FROM identity."RoleScope" WHERE role_id = $1 AND scope_id NOT IN (SELECT id FROM identity."Scope" WHERE key = ANY($2::text[]))`,
      [R.org, [...ORG_ADMIN_SCOPE_KEYS]],
    );
    await run(`DELETE FROM identity."RoleScope" WHERE role_id = $1 AND scope_id IN (SELECT id FROM identity."Scope" WHERE key LIKE 'sign:%')`, [R.owner]);
    await run(
      `INSERT INTO identity."RoleScope" (id, role_id, scope_id) SELECT gen_random_uuid(), $1, id FROM identity."Scope" WHERE key = ANY($2::text[])`,
      [R.ats, SIX_ORG_WIDE],
    );
    // A production-only grant on rows 0010 and 0014 (unknown to the seed).
    const extra = uuidv7();
    await run(`INSERT INTO identity."Scope" (id, key, description) VALUES ($1, $2, 'prod-only')`, [extra, EXTRA_SCOPE_KEY]);
    await run(`INSERT INTO identity."RoleScope" (id, role_id, scope_id) VALUES ($1, $2, $4), ($3, $5, $4)`, [uuidv7(), R.ats, uuidv7(), extra, R.owner]);

    // ── Tenants + memberships. ──────────────────────────────────────────────────
    tA = await tenant('ACTIVE');
    aOwner = await member(tA, [R.org, R.ats, R.owner, R.sown, R.sadm, R.sourcer]);
    aSender = await member(tA, [R.ssnd, R.recruiter]);
    aViewer = await member(tA, [R.svwr, R.recruiter]);
    tB = await tenant('PROVISIONED');
    bOwner = await member(tB, [R.org]);
    tC = await tenant('ACTIVE');
    cOwner = await member(tC, [R.owner]);
    cSignOwner = await member(tC, [R.sown, R.ssnd]);
    tD = await tenant('ACTIVE');
    dOwner = await member(tD, [R.owner]);
    dAdmin = await member(tD, [R.ats]);
    tE = await tenant('ACTIVE');
    e1 = await member(tE, [R.org]);
    e2 = await member(tE, [R.org]);
    // An existing authorization version for the Astre owner (bump → +1).
    await run(`INSERT INTO identity."AuthorizationVersion" (id, tenant_id, principal_id, version, updated_at) VALUES ($1, $2, $3, 5, now())`, [uuidv7(), tA, aOwner.user_id]);
  }, 300_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await container?.stop();
  }, 60_000);

  it('registration — the reconciliation is the last entry of the shared identity set', () => {
    expect(IDENTITY_MIGRATIONS.at(-1)).toBe(MIGRATION);
  });

  it('fresh database — the migration ran first as a no-op and the seed wrote the target model directly', async () => {
    expect(notices.some((n) => n.includes('no role catalog yet'))).toBe(true);
    expect(seedSets['ats']?.has('tenant:admin:settings')).toBe(false);
    expect(seedSets['org']?.has('sign:envelope:send')).toBe(true);
    expect(seedSets['owner']?.has('sign:billing:manage')).toBe(true);
  });

  it('fails CLOSED on an ambiguous ownerless tenant (two former org_admins) — nothing applied', async () => {
    const before = await snapshot();
    await expect(applyMigration()).rejects.toThrow(new RegExp(`ambiguous ownerless tenants.*${tE}`));
    expect(await snapshot()).toBe(before);
    const keys = await run(`SELECT key FROM identity."Role" WHERE id = ANY($1::uuid[]) ORDER BY id`, [[R.ats, R.org]]);
    expect(keys.rows.map((x) => x.key)).toEqual(['tenant_admin', 'org_admin']);
  });

  it('refuses a resolution row naming a user without an active membership in that tenant', async () => {
    const before = await snapshot();
    await run(`INSERT INTO identity."_roles1_owner_resolution" (tenant_id, user_id) VALUES ($1, $2)`, [tE, aOwner.user_id]);
    await expect(applyMigration()).rejects.toThrow(/owner resolution rows name a user without an active membership/);
    expect(await snapshot()).toBe(before);
    await run(`DELETE FROM identity."_roles1_owner_resolution"`);
  });

  it('with the resolution row filed it applies: keys renamed, descriptions rewritten, sign_owner deactivated', async () => {
    await run(`INSERT INTO identity."_roles1_owner_resolution" (tenant_id, user_id) VALUES ($1, $2)`, [tE, e2.user_id]);
    notices.length = 0;
    await applyMigration();
    const roles = await run(`SELECT id, key, description, is_active FROM identity."Role" WHERE id = ANY($1::uuid[])`, [[R.ats, R.org, R.owner, R.sown]]);
    const byId = new Map(roles.rows.map((x) => [x.id as string, x]));
    expect(byId.get(R.ats)?.key).toBe('ats_admin');
    expect(byId.get(R.org)?.key).toBe('tenant_admin');
    expect(byId.get(R.owner)?.key).toBe('tenant_owner');
    expect(String(byId.get(R.ats)?.description)).toMatch(/^ATS Admin — /);
    expect(String(byId.get(R.org)?.description)).toMatch(/^Tenant Admin — /);
    expect(String(byId.get(R.owner)?.description)).toMatch(/^Tenant Owner — /);
    expect(byId.get(R.sown)?.is_active).toBe(false);
    expect((await run(`SELECT count(*)::int AS n FROM identity."Role" WHERE key = 'org_admin'`)).rows[0].n).toBe(0);
  });

  it('bundles — relational on fixed ids, equal to the fresh-seed model (+ the production-only grant)', async () => {
    const withExtra = (s: Set<string> | undefined) => new Set([...(s ?? []), EXTRA_SCOPE_KEY]);
    const sorted = (s: Set<string>) => [...s].sort();
    expect(sorted(await roleScopeKeys(R.ats))).toEqual(sorted(withExtra(seedSets['ats'])));
    expect(sorted(await roleScopeKeys(R.org))).toEqual(sorted(withExtra(seedSets['org'])));
    expect(sorted(await roleScopeKeys(R.owner))).toEqual(sorted(withExtra(seedSets['owner'])));

    const owner = await roleScopeKeys(R.owner);
    const admin = await roleScopeKeys(R.org);
    const ats = await roleScopeKeys(R.ats);
    // D-3 — billing is owner-only.
    expect(owner.has('sign:billing:manage')).toBe(true);
    expect(admin.has('sign:billing:manage')).toBe(false);
    // Conforming Amendment 2 — both organization roles send.
    expect(owner.has('sign:envelope:send')).toBe(true);
    expect(admin.has('sign:envelope:send')).toBe(true);
    expect(ats.has('sign:envelope:send')).toBe(false);
    // sign:template:* is never carried onto the organization roles.
    for (const k of ['sign:template:use', 'sign:template:manage']) {
      expect(owner.has(k)).toBe(false);
      expect(admin.has(k)).toBe(false);
    }
    // tenant_admin = org set + every ats_admin scope + the Sign admin set.
    for (const k of ORG_ADMIN_SCOPE_KEYS) expect(admin.has(k)).toBe(true);
    for (const k of ats) expect(admin.has(k)).toBe(true);
    // D-2 — ats_admin loses the six organization-wide scopes, keeps the two baseline ones (F-6).
    for (const k of SIX_ORG_WIDE) expect(ats.has(k)).toBe(false);
    expect(ats.has('auth:session:read')).toBe(true);
    expect(ats.has('tenant:user:read:directory')).toBe(true);
    // The owner holds everything the administrator holds (+ billing).
    for (const k of admin) expect(owner.has(k)).toBe(true);
    // The new RoleScope rows carry the seed-identical deterministic id.
    const billingScope = (await run(`SELECT id FROM identity."Scope" WHERE key = 'sign:billing:manage'`)).rows[0].id as string;
    const row = await run(`SELECT id FROM identity."RoleScope" WHERE role_id = $1 AND scope_id = $2`, [R.owner, billingScope]);
    expect(row.rows[0].id).toBe(roles1RoleScopeId(R.owner, billingScope));
  });

  it('memberships — D-1, F-4 (evidence + resolution table), sign_owner reconciliation', async () => {
    // Astre-like: already an owner; sign_owner removed, sign_admin kept, old roles renamed.
    expect(await roleKeysOf(aOwner)).toEqual(['ats_admin', 'sign_admin', 'sourcer', 'tenant_admin', 'tenant_owner']);
    expect(await roleKeysOf(aSender)).toEqual(['recruiter', 'sign_sender']);
    expect(await roleKeysOf(aViewer)).toEqual(['recruiter', 'sign_viewer']);
    // Exactly one former org_admin in an ownerless PROVISIONED tenant → promoted (F-4).
    expect(await roleKeysOf(bOwner)).toEqual(['tenant_admin', 'tenant_owner']);
    // sign_owner holder WITHOUT tenant_owner: keeps Sign authority via sign_admin, NOT promoted.
    expect(await roleKeysOf(cSignOwner)).toEqual(['sign_admin', 'sign_sender']);
    expect(await roleKeysOf(cOwner)).toEqual(['tenant_owner']);
    // D-1: the old tenant_admin holder now holds ats_admin + tenant_admin.
    expect(await roleKeysOf(dAdmin)).toEqual(['ats_admin', 'tenant_admin']);
    expect(await roleKeysOf(dOwner)).toEqual(['tenant_owner']);
    // Ambiguous tenant resolved by the resolution table: exactly the named user.
    expect(await roleKeysOf(e2)).toEqual(['tenant_admin', 'tenant_owner']);
    expect(await roleKeysOf(e1)).toEqual(['tenant_admin']);
    // Nobody holds sign_owner any more.
    expect((await run(`SELECT count(*)::int AS n FROM identity."UserTenantMembershipRole" WHERE role_id = $1`, [R.sown])).rows[0].n).toBe(0);
    // The reconciliation report.
    expect(notices.some((n) => n.includes('sign_owner holders WITHOUT tenant_owner') && n.includes(cSignOwner.user_id))).toBe(true);
    expect(notices.some((n) => n.includes('ownerless ACTIVE/PROVISIONED tenants') && n.includes(SEED_IDS.platform_tenant))).toBe(true);
  });

  it('evidence — one audit row per granted / removed role (system actor, reason D1 | F4 | SIGN_OWNER)', async () => {
    const r = await run(
      `SELECT event_type, tenant_id, subject_id, actor_type, actor_id, event_payload->>'reason' AS reason, event_payload->>'role_key' AS role_key
       FROM identity."IdentityAuditEvent" WHERE event_type LIKE 'ROLES1_%' ORDER BY event_type, reason, role_key, subject_id`,
    );
    const rows = r.rows.map((x) => `${x.event_type}|${x.reason}|${x.role_key}|${x.subject_id}`).sort();
    const expected = [
      // D-1: every holder of row 0010 (the Astre owner, the tD admin).
      `ROLES1_RECONCILE_GRANT|D1|tenant_admin|${dAdmin.user_id}`,
      // F-4: the single former org_admin of tB, the resolution-table owner of tE.
      `ROLES1_RECONCILE_GRANT|F4|tenant_owner|${bOwner.user_id}`,
      `ROLES1_RECONCILE_GRANT|F4|tenant_owner|${e2.user_id}`,
      // sign_owner without tenant_owner → sign_admin ensured.
      `ROLES1_RECONCILE_GRANT|SIGN_OWNER|sign_admin|${cSignOwner.user_id}`,
      // sign_owner removed from both holders.
      `ROLES1_RECONCILE_REVOKE|SIGN_OWNER|sign_owner|${aOwner.user_id}`,
      `ROLES1_RECONCILE_REVOKE|SIGN_OWNER|sign_owner|${cSignOwner.user_id}`,
    ].sort();
    // The Astre owner already held row 02b0 (org_admin), so D-1 inserts nothing for them.
    expect(rows).toEqual(expected);
    for (const x of r.rows) {
      expect(x.actor_type).toBe('system');
      expect(x.actor_id).toBe(SEED_IDS.service_account_system);
      expect(x.tenant_id).not.toBeNull();
    }
  });

  it('AuthorizationVersion — bumped exactly for the principals whose effective scope set changed', async () => {
    // The Astre-like owner's EFFECTIVE set is unchanged (every scope sign_owner carried is
    // still held via tenant_owner + sign_admin; the renamed rows' scopes stay in the union),
    // so the version is NOT bumped — the production Astre owner's case.
    expect(await version(aOwner)).toBe(5);
    expect(await version(bOwner)).toBe(2); // promoted
    expect(await version(cOwner)).toBe(2); // tenant_owner bundle grew
    expect(await version(cSignOwner)).toBe(2); // sign_owner → sign_admin (loses billing)
    expect(await version(dAdmin)).toBe(2); // D-1 (gains Sign admin scopes)
    expect(await version(e1)).toBe(2); // org_admin → tenant_admin (bundle grew)
    expect(await version(e2)).toBe(2);
    // Unchanged effective sets → no bump.
    expect(await version(aSender)).toBeNull();
    expect(await version(aViewer)).toBeNull();
  });

  it('the PR-1 last-owner invariant still holds afterwards (the promoted owner is protected)', async () => {
    await expect(
      run(`DELETE FROM identity."UserTenantMembershipRole" WHERE membership_id = $1 AND role_id = $2`, [bOwner.membership_id, R.owner]),
    ).rejects.toThrow(/tenant_last_owner/);
  });

  it('idempotent — a re-run is a no-op', async () => {
    const before = await snapshot();
    notices.length = 0;
    await applyMigration();
    expect(await snapshot()).toBe(before);
    expect(notices.some((n) => n.includes('already applied'))).toBe(true);
  });

  it('the seed re-run on the migrated database changes nothing (the deploy order: migrate, then seed)', async () => {
    const before = await snapshot();
    await runIdentitySeed(prisma, { includeDevFixtures: false });
    expect(await snapshot()).toBe(before);
  });
});
