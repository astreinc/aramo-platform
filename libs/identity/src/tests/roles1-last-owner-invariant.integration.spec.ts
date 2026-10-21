import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { AramoError, ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS, resolveIdentityMigrations } from '@aramo/common';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';

import { IdentityRepository } from '../lib/identity.repository.js';
import { PrismaService } from '../lib/prisma/prisma.service.js';

// ROLES-1 PR-1 — Aramo-ROLES-1 Implementation Directive v1.0 (LOCKED) §4.1, on real Postgres:
//   - removing a tenant's LAST active tenant_owner is refused by the database (role-row
//     delete / re-point, membership deactivate / delete, User deactivation);
//   - removing a non-last owner is fine;
//   - two concurrent transactions removing the last two owners: exactly one commits
//     (the per-tenant advisory lock + recount after the lock), under READ COMMITTED and
//     under REPEATABLE READ;
//   - safeguard S-1: no session setting skips the check (a plausible custom GUC and the
//     superuser session_replication_role = replica are both ignored);
//   - an already-ownerless PROVISIONED tenant (the platform sentinel shape) is not blocked
//     by unrelated writes, and a tenant outside ACTIVE/PROVISIONED is not checked;
//   - the repository maps the refusal to 409 TENANT_LAST_OWNER (never a raw 500).

const ROOT = resolve(__dirname, '../../../..');
const OWNER_ROLE = '01900000-0000-7000-8000-000000000014';
const RECRUITER_ROLE = '01900000-0000-7000-8000-000000000011';
const SENTINEL = '01900000-0000-7000-8000-000000000100';
const MIGRATION = 'libs/identity/prisma/migrations/20261021120100_roles1_last_owner_invariant/migration.sql';

type Member = { user_id: string; membership_id: string; assignment_id: string };

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('ROLES-1 PR-1 last-owner invariant (real Postgres)', () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let db2: Client;
  let prisma: PrismaService;
  let repo: IdentityRepository;

  beforeAll(async () => {
    container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
    db = new Client({ connectionString: container.getConnectionUri() });
    db2 = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await db2.connect();
    for (const p of resolveIdentityMigrations(ROOT)) await db.query(readFileSync(p, 'utf8'));
    await db.query(
      `INSERT INTO identity."Role" (id, key, description, is_active, updated_at) VALUES ($1, 'tenant_owner', 'Owner', true, now()), ($2, 'recruiter', 'Recruiter', true, now())`,
      [OWNER_ROLE, RECRUITER_ROLE],
    );
    prisma = new PrismaService(container.getConnectionUri());
    await prisma.$connect();
    repo = new IdentityRepository(prisma);
  }, 240_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.end();
    await db2?.end();
    await container?.stop();
  }, 60_000);

  async function tenant(status: 'ACTIVE' | 'PROVISIONED' | 'SUSPENDED' | 'CLOSED' = 'ACTIVE', id: string = uuidv7()): Promise<string> {
    await db.query(`INSERT INTO identity."Tenant" (id, name, status, updated_at) VALUES ($1, $2, $3, now())`, [id, `T ${id}`, status]);
    return id;
  }
  async function member(tenant_id: string, role: string, membershipActive = true): Promise<Member> {
    const user_id = uuidv7();
    const membership_id = uuidv7();
    const assignment_id = uuidv7();
    await db.query(`INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at) VALUES ($1, $2, 'U', true, $3, now())`, [user_id, `u-${user_id}@acme.test`, tenant_id]);
    await db.query(`INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, updated_at) VALUES ($1, $2, $3, $4, now())`, [membership_id, user_id, tenant_id, membershipActive]);
    await db.query(`INSERT INTO identity."UserTenantMembershipRole" (id, membership_id, role_id) VALUES ($1, $2, $3)`, [assignment_id, membership_id, role]);
    return { user_id, membership_id, assignment_id };
  }
  const owners = async (t: string): Promise<number> =>
    Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM identity."UserTenantMembershipRole" r JOIN identity."UserTenantMembership" m ON m.id = r.membership_id JOIN identity."User" u ON u.id = m.user_id JOIN identity."Role" ro ON ro.id = r.role_id WHERE m.tenant_id = $1 AND m.is_active AND u.is_active AND ro.key = 'tenant_owner'`,
          [t],
        )
      ).rows[0].n,
    );
  const LAST_OWNER = /tenant_last_owner/;

  it('registration — the migration is in the shared identity set (before the ROLES-1 PR-2 reconciliation) and installs 5 ENABLE ALWAYS triggers', async () => {
    // Order-based (not tail-pinned): later increments (e.g. DOC-TEMPLATE-LIB-1 T-4/T-5 grant
    // migrations) append after the ROLES-1 PR-2 reconciliation, which must follow this one.
    const roleModel = 'libs/identity/prisma/migrations/20261021130000_roles1_role_model/migration.sql';
    expect(IDENTITY_MIGRATIONS).toContain(MIGRATION);
    expect(IDENTITY_MIGRATIONS.indexOf(roleModel)).toBeGreaterThan(IDENTITY_MIGRATIONS.indexOf(MIGRATION));
    const r = await db.query(
      `SELECT tgname, tgenabled FROM pg_trigger WHERE tgname LIKE 'roles1_last_owner_%' AND NOT tgisinternal ORDER BY tgname`,
    );
    expect(r.rows.map((x) => x.tgname)).toEqual([
      'roles1_last_owner_membership_delete',
      'roles1_last_owner_membership_update',
      'roles1_last_owner_role_delete',
      'roles1_last_owner_role_update',
      'roles1_last_owner_user_update',
    ]);
    // 'A' = ENABLE ALWAYS (fires under every session_replication_role).
    expect(new Set(r.rows.map((x) => x.tgenabled))).toEqual(new Set(['A']));
  });

  it('replay-safe — re-applying the migration leaves exactly the same 5 triggers', async () => {
    await db.query(readFileSync(resolve(ROOT, MIGRATION), 'utf8'));
    const r = await db.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'roles1_last_owner_%' AND NOT tgisinternal`);
    expect(r.rows[0].n).toBe(5);
  });

  it('removing the LAST owner role row raises tenant_last_owner; nothing changes', async () => {
    const t = await tenant('ACTIVE');
    const o = await member(t, OWNER_ROLE);
    await expect(db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [o.assignment_id])).rejects.toThrow(LAST_OWNER);
    expect(await owners(t)).toBe(1);
  });

  it('re-pointing the last owner assignment to another role raises; to another tenant\'s membership raises', async () => {
    const t = await tenant('PROVISIONED');
    const o = await member(t, OWNER_ROLE);
    await expect(db.query(`UPDATE identity."UserTenantMembershipRole" SET role_id = $2 WHERE id = $1`, [o.assignment_id, RECRUITER_ROLE])).rejects.toThrow(LAST_OWNER);
    const t2 = await tenant('ACTIVE');
    const other = await member(t2, RECRUITER_ROLE);
    await expect(db.query(`UPDATE identity."UserTenantMembershipRole" SET membership_id = $2 WHERE id = $1`, [o.assignment_id, other.membership_id])).rejects.toThrow(LAST_OWNER);
    expect(await owners(t)).toBe(1);
  });

  it('removing a NON-last owner is allowed (one statement removing all owners is not)', async () => {
    const t = await tenant('ACTIVE');
    const a = await member(t, OWNER_ROLE);
    const b = await member(t, OWNER_ROLE);
    const c = await member(t, OWNER_ROLE);
    await db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [a.assignment_id]);
    expect(await owners(t)).toBe(2);
    await expect(
      db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = ANY($1::uuid[])`, [[b.assignment_id, c.assignment_id]]),
    ).rejects.toThrow(LAST_OWNER);
    expect(await owners(t)).toBe(2);
  });

  it('membership deactivation of the last owner raises; of a non-last owner is fine', async () => {
    const t = await tenant('ACTIVE');
    const a = await member(t, OWNER_ROLE);
    const b = await member(t, OWNER_ROLE);
    await db.query(`UPDATE identity."UserTenantMembership" SET is_active = false WHERE id = $1`, [a.membership_id]);
    await expect(db.query(`UPDATE identity."UserTenantMembership" SET is_active = false WHERE id = $1`, [b.membership_id])).rejects.toThrow(LAST_OWNER);
    expect(await owners(t)).toBe(1);
  });

  it('membership DELETE of the last owner is refused (FK RESTRICT on its role rows, or the invariant once they are gone)', async () => {
    const t = await tenant('ACTIVE');
    const o = await member(t, OWNER_ROLE);
    await expect(db.query(`DELETE FROM identity."UserTenantMembership" WHERE id = $1`, [o.membership_id])).rejects.toThrow();
    expect(await owners(t)).toBe(1);
  });

  it('USER deactivation of the last owner raises (every tenant where the user is an owner); a non-last owner user is fine', async () => {
    const t = await tenant('ACTIVE');
    const a = await member(t, OWNER_ROLE);
    const b = await member(t, OWNER_ROLE);
    await db.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [a.user_id]);
    expect(await owners(t)).toBe(1);
    await expect(db.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [b.user_id])).rejects.toThrow(LAST_OWNER);
    expect(await owners(t)).toBe(1);
    // Unrelated User updates on the last owner are untouched.
    await db.query(`UPDATE identity."User" SET display_name = 'Renamed' WHERE id = $1`, [b.user_id]);
  });

  it('S-1 — no session setting skips the check (custom GUCs, session_replication_role = replica)', async () => {
    const t = await tenant('ACTIVE');
    const o = await member(t, OWNER_ROLE);
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL aramo.owner_guard_bypass = 'on'`);
      await db.query(`SET LOCAL aramo.skip_last_owner = 'true'`);
      await db.query(`SET LOCAL identity.owner_guard = 'off'`);
      // Superuser-only replication role: silences ORIGIN triggers — not ENABLE ALWAYS ones.
      await db.query(`SET LOCAL session_replication_role = replica`);
      await expect(db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [o.assignment_id])).rejects.toThrow(LAST_OWNER);
    } finally {
      await db.query('ROLLBACK');
    }
    expect(await owners(t)).toBe(1);
    // The function bodies read no setting at all.
    const src = await db.query(`SELECT string_agg(prosrc, ' ') AS s FROM pg_proc WHERE proname LIKE 'roles1_%'`);
    expect(src.rows[0].s).not.toMatch(/current_setting|set_config|pg_settings/i);
  });

  // The second remover must be BLOCKED behind the first (on the per-tenant advisory lock, or
  // on an owner row the first one's recount holds FOR SHARE) until the first commits.
  async function waitForLockWait(pid: number): Promise<string> {
    for (let i = 0; i < 100; i++) {
      const r = await db.query(`SELECT wait_event_type, wait_event FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (r.rows[0]?.wait_event_type === 'Lock') return String(r.rows[0].wait_event);
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new Error('second transaction never blocked behind the first owner removal');
  }

  for (const isolation of ['READ COMMITTED', 'REPEATABLE READ'] as const) {
    it(`concurrency (${isolation}) — two transactions each removing one of the last two owners: exactly one commits`, async () => {
      const t = await tenant('ACTIVE');
      const a = await member(t, OWNER_ROLE);
      const b = await member(t, OWNER_ROLE);
      const txA = new Client({ connectionString: container.getConnectionUri() });
      const txB = new Client({ connectionString: container.getConnectionUri() });
      await txA.connect();
      await txB.connect();
      try {
        await txA.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        await txB.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        // Take B's snapshot BEFORE A commits (the REPEATABLE READ hazard).
        await txB.query('SELECT 1 FROM identity."Tenant" LIMIT 1');
        await txA.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [a.assignment_id]);
        const pidB = Number((await txB.query('SELECT pg_backend_pid() AS p')).rows[0].p);
        const bDelete = txB
          .query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [b.assignment_id])
          .then(() => 'ok' as const, (e: Error) => e.message);
        expect(['advisory', 'transactionid', 'tuple']).toContain(await waitForLockWait(pidB)); // B is serialized behind A
        await txA.query('COMMIT');
        const outcome = await bDelete;
        await txB.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK');
        expect(outcome).not.toBe('ok');
        expect(outcome).toMatch(isolation === 'READ COMMITTED' ? LAST_OWNER : /tenant_last_owner|could not serialize access/);
        expect(await owners(t)).toBe(1);
      } finally {
        await txA.end();
        await txB.end();
      }
    });
  }

  it('concurrency — deactivating one owner user while another transaction demotes the other owner: exactly one commits', async () => {
    const t = await tenant('ACTIVE');
    const a = await member(t, OWNER_ROLE);
    const b = await member(t, OWNER_ROLE);
    await db2.query('BEGIN');
    await db2.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [a.user_id]);
    const pid2 = Number((await db2.query('SELECT pg_backend_pid() AS p')).rows[0].p);
    expect(pid2).toBeGreaterThan(0);
    const tx = new Client({ connectionString: container.getConnectionUri() });
    await tx.connect();
    try {
      await tx.query('BEGIN');
      const pidT = Number((await tx.query('SELECT pg_backend_pid() AS p')).rows[0].p);
      const demote = tx
        .query(`UPDATE identity."UserTenantMembershipRole" SET role_id = $2 WHERE id = $1`, [b.assignment_id, RECRUITER_ROLE])
        .then(() => 'ok' as const, (e: Error) => e.message);
      expect(['advisory', 'transactionid', 'tuple']).toContain(await waitForLockWait(pidT));
      await db2.query('COMMIT');
      const outcome = await demote;
      await tx.query(outcome === 'ok' ? 'COMMIT' : 'ROLLBACK');
      expect(outcome).toMatch(LAST_OWNER);
      expect(await owners(t)).toBe(1);
    } finally {
      await tx.end();
    }
  });

  it('an already-ownerless PROVISIONED tenant (the sentinel shape) is not blocked by unrelated writes', async () => {
    const t = await tenant('PROVISIONED', SENTINEL);
    expect(await owners(t)).toBe(0);
    const r = await member(t, RECRUITER_ROLE);
    // An INACTIVE owner membership in the same tenant (never counted) — removing its owner
    // assignment is an unrelated write too.
    const ghost = await member(t, OWNER_ROLE, false);
    expect(await owners(t)).toBe(0);
    await db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [ghost.assignment_id]);
    await db.query(`UPDATE identity."UserTenantMembershipRole" SET role_id = $2 WHERE id = $1`, [r.assignment_id, RECRUITER_ROLE]);
    await db.query(`UPDATE identity."UserTenantMembership" SET is_active = false WHERE id = $1`, [r.membership_id]);
    await db.query(`UPDATE identity."User" SET is_active = false WHERE id = $1`, [r.user_id]);
    await db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [r.assignment_id]);
    expect(await owners(t)).toBe(0);
  });

  it('a tenant outside ACTIVE/PROVISIONED is not checked (the legitimate path: move the tenant out first)', async () => {
    const suspended = await tenant('SUSPENDED');
    const s = await member(suspended, OWNER_ROLE);
    await db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [s.assignment_id]);
    expect(await owners(suspended)).toBe(0);
    const t = await tenant('ACTIVE');
    const o = await member(t, OWNER_ROLE);
    await db.query(`UPDATE identity."Tenant" SET status = 'CLOSED' WHERE id = $1`, [t]);
    await db.query(`UPDATE identity."UserTenantMembership" SET is_active = false WHERE id = $1`, [o.membership_id]);
    expect(await owners(t)).toBe(0);
  });

  it('granting another owner first, then removing the original, is the legitimate hand-over', async () => {
    const t = await tenant('ACTIVE');
    const a = await member(t, OWNER_ROLE);
    await member(t, OWNER_ROLE);
    await db.query(`DELETE FROM identity."UserTenantMembershipRole" WHERE id = $1`, [a.assignment_id]);
    expect(await owners(t)).toBe(1);
  });

  it('repository mapping — replaceMembershipRoles / disableMembership surface 409 TENANT_LAST_OWNER and roll back', async () => {
    const t = await tenant('ACTIVE');
    const o = await member(t, OWNER_ROLE);
    const demote = repo.replaceMembershipRoles({ membership_id: o.membership_id, role_ids: [RECRUITER_ROLE], request_id: 'req-roles1' });
    await expect(demote).rejects.toBeInstanceOf(AramoError);
    await expect(
      repo.replaceMembershipRoles({ membership_id: o.membership_id, role_ids: [RECRUITER_ROLE], request_id: 'req-roles1' }),
    ).rejects.toMatchObject({ code: 'TENANT_LAST_OWNER', statusCode: 409, context: { requestId: 'req-roles1', details: { reason: 'last_owner' } } });
    // Rolled back: the recruiter grant inside the same transaction did not persist either.
    const roles = await db.query(`SELECT role_id FROM identity."UserTenantMembershipRole" WHERE membership_id = $1`, [o.membership_id]);
    expect(roles.rows.map((x) => x.role_id)).toEqual([OWNER_ROLE]);
    await expect(repo.disableMembership({ user_id: o.user_id, tenant_id: t, request_id: 'req-dis' })).rejects.toMatchObject({
      code: 'TENANT_LAST_OWNER',
      statusCode: 409,
      context: { requestId: 'req-dis', details: { tenant_id: t } },
    });
    expect(await owners(t)).toBe(1);
    // A second owner makes both operations succeed.
    await member(t, OWNER_ROLE);
    await repo.replaceMembershipRoles({ membership_id: o.membership_id, role_ids: [RECRUITER_ROLE] });
    expect(await owners(t)).toBe(1);
  });
});
