import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { ARAMO_POSTGRES_TEST_IMAGE, IDENTITY_MIGRATIONS } from '@aramo/common';

import { PrismaService } from '../lib/prisma/prisma.service.js';

// IC-1 PR-2 — L20: MIGRATION REPLAY on a production-shaped identity database
// (real Postgres 17). Proves, as the Lead's two implementation safeguards require:
//
//   (1) FAILURE ATOMICITY — the backfill file, run the way production runs it
//       (one file = one transaction: tools/db-sync-local.sh `psql --single-
//       transaction -f`), RAISES when any User would remain unowned and the
//       WHOLE file rolls back (no partial assignment survives), for both the
//       multi-membership and the membership-less residue.
//   (2) OLD/NEW COMPATIBILITY — after `expand`, a writer that knows nothing
//       about the column (the currently deployed image) still inserts and reads
//       Users; the regenerated client reads the same rows with `tenant_id =
//       null`; and the new creation transactions populate `tenant_id`.
//
// Plus: the production-shaped success case (3 Users / 3 memberships / 2 Tenants
// incl. the platform sentinel → every User owned, super_admin → sentinel),
// idempotent re-run, and the splitter-safety of both files for every line-based
// migration splitter in the harness (no inner statement terminator, no `$$`).
//
// Each case gets its OWN database inside one container so the abort cases
// cannot contaminate the success case.

const ROOT = resolve(__dirname, '../../../..');
const EXPAND = IDENTITY_MIGRATIONS.find((p) => p.includes('ic1_user_tenant_owner_expand'));
const BACKFILL = IDENTITY_MIGRATIONS.find((p) => p.includes('ic1_user_tenant_owner_backfill'));
if (EXPAND === undefined || BACKFILL === undefined) {
  throw new Error('IC-1 PR-2 migrations are not registered in IDENTITY_MIGRATIONS');
}
const PRE_PR2 = IDENTITY_MIGRATIONS.filter((p) => p !== EXPAND && p !== BACKFILL);
const sqlOf = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

// Production ids (IC-0 preflight shape): the platform sentinel tenant id is the
// libs/auth PLATFORM_TENANT_SENTINEL_ID; the other tenant stands in for Astre.
const SENTINEL = '01900000-0000-7000-8000-000000000100';
const ASTRE = '01900000-0000-7000-8000-0000000000a1';
const ROLE_OWNER = '01900000-0000-7000-8000-000000000014';

// Line-based splitters as they exist in the harness: the regex form used by 15
// identity consumers, and the scanner form (splits on EVERY `;`) used by one.
function regexSplit(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}
function everySemicolonSplit(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'IC-1 PR-2 — migration replay: expand + backfill on a production-shaped identity DB (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let adminUrl: string;
    const clients: Client[] = [];
    const prismas: PrismaService[] = [];

    // A fresh database with every identity migration BEFORE PR-2 applied (whole-
    // file simple-query protocol — `$$`-safe, one implicit transaction per file).
    async function freshDb(name: string): Promise<{ db: Client; url: string }> {
      const admin = new Client({ connectionString: adminUrl });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      await admin.end();
      const url = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
      const db = new Client({ connectionString: url });
      await db.connect();
      clients.push(db);
      for (const rel of PRE_PR2) await db.query(sqlOf(rel));
      return { db, url };
    }

    // Run one migration FILE the way production does (`psql -v ON_ERROR_STOP=1
    // --single-transaction -f`): BEGIN … file … COMMIT; on the first error psql
    // stops and the session ends, which rolls the open transaction back. Here the
    // session is reused, so the rollback is issued explicitly before rethrowing —
    // the observable guarantee is identical: nothing from the file persists.
    async function applyFileAsOneTransaction(db: Client, rel: string): Promise<void> {
      try {
        await db.query(`BEGIN;\n${sqlOf(rel)}\nCOMMIT;`);
      } catch (err) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }

    async function seedTenantsAndRole(db: Client): Promise<void> {
      await db.query(
        `INSERT INTO identity."Tenant" (id, name, is_active, status, updated_at)
         VALUES ($1::uuid, 'Astre Consulting', true, 'ACTIVE', now()),
                ($2::uuid, 'Aramo Platform', true, 'PROVISIONED', now())`,
        [ASTRE, SENTINEL],
      );
      await db.query(
        `INSERT INTO identity."Role" (id, key, description, is_active, updated_at)
         VALUES ($1::uuid, 'tenant_owner', 'Tenant Owner', true, now())`,
        [ROLE_OWNER],
      );
    }

    // The PRE-PR-2 writer shape (the currently deployed image): no tenant_id column.
    async function oldImageInsertUser(db: Client, id: string, email: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, true, now())`,
        [id, email, email],
      );
    }
    async function insertMembership(db: Client, user_id: string, tenant_id: string, invite_status = 'ACTIVE'): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO identity."UserTenantMembership" (id, user_id, tenant_id, is_active, invite_status, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, true, $4, now())`,
        [id, user_id, tenant_id, invite_status],
      );
      return id;
    }
    async function ownerMap(db: Client): Promise<Map<string, string | null>> {
      const r = await db.query<{ id: string; tenant_id: string | null }>(
        `SELECT id, tenant_id FROM identity."User" ORDER BY id`,
      );
      return new Map(r.rows.map((x) => [x.id, x.tenant_id]));
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer(ARAMO_POSTGRES_TEST_IMAGE).start();
      adminUrl = container.getConnectionUri();
    }, 120_000);

    afterAll(async () => {
      for (const p of prismas) await p.$disconnect();
      for (const c of clients) await c.end().catch(() => undefined);
      await container?.stop();
    });

    it('splitter safety — both files survive the regex splitter (4 + 2 statements) AND a split-on-every-semicolon scanner (no inner terminator, no $$)', () => {
      const expandSql = sqlOf(EXPAND);
      const backfillSql = sqlOf(BACKFILL);
      expect(regexSplit(expandSql)).toHaveLength(4);
      expect(regexSplit(backfillSql)).toHaveLength(2);
      expect(everySemicolonSplit(expandSql)).toHaveLength(4);
      expect(everySemicolonSplit(backfillSql)).toHaveLength(2);
      expect(expandSql).not.toContain('$$');
      expect(backfillSql).not.toContain('$$');
      // The post-condition is a SELECT that raises, never a DO block.
      expect(backfillSql).not.toMatch(/\bDO\b/);
    });

    it('SUCCESS (production shape) — 3 Users / 3 memberships / 2 Tenants → every User owned by its single membership tenant; super_admin → platform sentinel; re-run is a no-op', async () => {
      const { db, url } = await freshDb('ic1_ok');
      await seedTenantsAndRole(db);
      const owner = uuidv7();
      const superAdmin = uuidv7();
      const invitee = uuidv7();
      await oldImageInsertUser(db, owner, 'owner@astre.example');
      await oldImageInsertUser(db, superAdmin, 'platform.owner@aramo.example');
      await oldImageInsertUser(db, invitee, 'invitee@astre.example');
      await insertMembership(db, owner, ASTRE);
      await insertMembership(db, superAdmin, SENTINEL);
      await insertMembership(db, invitee, ASTRE, 'INVITED');

      await applyFileAsOneTransaction(db, EXPAND);
      // After expand, before backfill: column exists, all NULL, old shape intact.
      const before = await ownerMap(db);
      expect([...before.values()]).toEqual([null, null, null]);

      await applyFileAsOneTransaction(db, BACKFILL);
      const after = await ownerMap(db);
      expect(after.get(owner)).toBe(ASTRE);
      expect(after.get(superAdmin)).toBe(SENTINEL);
      expect(after.get(invitee)).toBe(ASTRE);
      const nulls = await db.query(`SELECT count(*)::int AS n FROM identity."User" WHERE tenant_id IS NULL`);
      expect(nulls.rows[0]?.n).toBe(0);

      // Idempotent: a second run changes nothing and does not raise.
      await applyFileAsOneTransaction(db, BACKFILL);
      expect(await ownerMap(db)).toEqual(after);

      // The regenerated Prisma client reads the owned rows (tenant_id populated)
      // and the owner relation resolves.
      const prisma = new PrismaService(url);
      await prisma.$connect();
      prismas.push(prisma);
      const row = await prisma.user.findUnique({ where: { id: superAdmin }, include: { owner_tenant: true } });
      expect(row?.tenant_id).toBe(SENTINEL);
      expect(row?.owner_tenant?.name).toBe('Aramo Platform');
      // Constraints from expand are in place: the FK rejects an unknown owner.
      await expect(
        db.query(`UPDATE identity."User" SET tenant_id = $1::uuid WHERE id = $2::uuid`, [uuidv7(), invitee]),
      ).rejects.toThrow(/User_tenant_id_fkey/);
    });

    it('ABORT + ROLLBACK (multi-membership residue) — the backfill file raises with the governed message and NOTHING is assigned, not even for the clean Users', async () => {
      const { db } = await freshDb('ic1_multi');
      await seedTenantsAndRole(db);
      const clean = uuidv7();
      const multi = uuidv7();
      await oldImageInsertUser(db, clean, 'clean@astre.example');
      await oldImageInsertUser(db, multi, 'multi@astre.example');
      await insertMembership(db, clean, ASTRE);
      await insertMembership(db, multi, ASTRE);
      await insertMembership(db, multi, SENTINEL);
      await applyFileAsOneTransaction(db, EXPAND);

      await expect(applyFileAsOneTransaction(db, BACKFILL)).rejects.toThrow(
        /ic1 backfill incomplete: 1 User rows without tenant_id/,
      );
      // The transaction aborted as a whole: the clean User's assignment did NOT survive.
      const after = await ownerMap(db);
      expect(after.get(clean)).toBeNull();
      expect(after.get(multi)).toBeNull();
      // The connection is usable again (no dangling aborted transaction).
      const ok = await db.query('SELECT 1 AS one');
      expect(ok.rows[0]?.one).toBe(1);
    });

    it('ABORT + ROLLBACK (membership-less residue) — a User with no membership aborts the file the same way', async () => {
      const { db } = await freshDb('ic1_orphan');
      await seedTenantsAndRole(db);
      const clean = uuidv7();
      const orphan = uuidv7();
      await oldImageInsertUser(db, clean, 'clean2@astre.example');
      await oldImageInsertUser(db, orphan, 'orphan@astre.example');
      await insertMembership(db, clean, ASTRE);
      await applyFileAsOneTransaction(db, EXPAND);

      await expect(applyFileAsOneTransaction(db, BACKFILL)).rejects.toThrow(
        /ic1 backfill incomplete: 1 User rows without tenant_id/,
      );
      const after = await ownerMap(db);
      expect(after.get(clean)).toBeNull();
      expect(after.get(orphan)).toBeNull();
    });

    it('OLD/NEW COMPATIBILITY — after expand (+backfill) an OLD-image writer still inserts and reads Users without naming the column; the NEW client reads them as tenant_id = null; the full column set is unchanged apart from the addition', async () => {
      const { db, url } = await freshDb('ic1_compat');
      await seedTenantsAndRole(db);
      await applyFileAsOneTransaction(db, EXPAND);
      await applyFileAsOneTransaction(db, BACKFILL); // empty table → no-op, no raise

      // The deployed image during the migrate→recreate window: pre-PR-2 column list.
      const legacy = uuidv7();
      await oldImageInsertUser(db, legacy, 'legacy@astre.example');
      await insertMembership(db, legacy, ASTRE);
      const oldRead = await db.query<{ id: string; email: string; is_active: boolean }>(
        `SELECT id, email, display_name, is_active, deactivated_at, created_at, updated_at
           FROM identity."User" WHERE id = $1::uuid`,
        [legacy],
      );
      expect(oldRead.rows).toHaveLength(1);
      expect(oldRead.rows[0]?.email).toBe('legacy@astre.example');

      const prisma = new PrismaService(url);
      await prisma.$connect();
      prismas.push(prisma);
      const viaNewClient = await prisma.user.findUnique({ where: { id: legacy } });
      expect(viaNewClient?.tenant_id).toBeNull();

      // The window row is exactly what the PR-3 re-run of the backfill repairs.
      await applyFileAsOneTransaction(db, BACKFILL);
      expect((await prisma.user.findUnique({ where: { id: legacy } }))?.tenant_id).toBe(ASTRE);

      // Column inventory: the 7 pre-PR-2 columns + tenant_id, nothing else changed.
      const cols = await db.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'identity' AND table_name = 'User' ORDER BY ordinal_position`,
      );
      expect(cols.rows.map((c) => c.column_name)).toEqual([
        'id', 'email', 'display_name', 'is_active', 'deactivated_at', 'created_at', 'updated_at', 'tenant_id',
      ]);
      expect(cols.rows.find((c) => c.column_name === 'tenant_id')?.is_nullable).toBe('YES');
      // email uniqueness is untouched.
      const uniques = await db.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE conrelid = 'identity."User"'::regclass ORDER BY conname`,
      );
      expect(uniques.rows.map((r) => r.conname)).toEqual([
        'User_id_tenant_id_key', 'User_pkey', 'User_tenant_id_fkey',
      ]);
      const emailIdx = await db.query(
        `SELECT indexname FROM pg_indexes WHERE schemaname = 'identity' AND tablename = 'User' AND indexname = 'User_email_key'`,
      );
      expect(emailIdx.rows).toHaveLength(1);
    });
  },
);
