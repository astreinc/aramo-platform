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

// IC-1 PR-2 + PR-3 — L20: MIGRATION REPLAY on a production-shaped identity database
// (real Postgres 17). Proves, as the Lead's implementation safeguards require:
//
//   PR-2 (expand + backfill)
//   (1) FAILURE ATOMICITY — the backfill file, run the way production runs it
//       (one file = one transaction: tools/db-sync-local.sh `psql --single-
//       transaction -f`), RAISES when any User would remain unowned and the
//       WHOLE file rolls back, for both the multi-membership and the
//       membership-less residue.
//   (2) OLD/NEW COMPATIBILITY — after `expand`, a writer that knows nothing
//       about the column (a pre-PR-2 image) still inserts and reads Users; the
//       regenerated client reads the same rows with `tenant_id = null`.
//
//   PR-3 (restrict: cardinality + immutability) — readiness v1.2 §7, §11
//   (3) SUCCESS on the production shape; every constraint present afterwards.
//   (4) FAILURE ATOMICITY of the `cardinality` file for EACH pre-validation
//       (unowned / multi-membership / membership-owner mismatch): the raise rolls
//       back the ENTIRE file — NOT NULL, the unique index and the composite FK
//       are all absent, and a backfill assignment made earlier in the same file
//       does NOT survive.
//   (5) TRIGGER REPLAY — the `immutable` file applied twice yields exactly one
//       trigger and no error; the raise still fires.
//   (6) RELEASE ORDERING — after the restriction a pre-PR-2 writer is REFUSED
//       (NOT NULL), which is why the eventual production release is two-step
//       (Release A = PR-2 expansion + image; Release B = PR-3 restriction).
//   (7) SPLITTER SAFETY — the PR-3 files survive the regex splitter and a
//       QUOTE-AWARE scanner; the naive split-on-every-semicolon scanner is shown
//       to break the quoted plpgsql body (the reason the one scanner-blind
//       consumer was made quote-aware in PR-3).
//
// Each case gets its OWN database inside one container so the abort cases
// cannot contaminate the success cases.

const ROOT = resolve(__dirname, '../../../..');
const EXPAND = IDENTITY_MIGRATIONS.find((p) => p.includes('ic1_user_tenant_owner_expand'));
const BACKFILL = IDENTITY_MIGRATIONS.find((p) => p.includes('ic1_user_tenant_owner_backfill'));
const CARDINALITY = IDENTITY_MIGRATIONS.find((p) => p.includes('ic1_user_tenant_cardinality'));
const IMMUTABLE = IDENTITY_MIGRATIONS.find((p) => p.includes('ic1_user_tenant_immutable'));
if (EXPAND === undefined || BACKFILL === undefined || CARDINALITY === undefined || IMMUTABLE === undefined) {
  throw new Error('IC-1 PR-2/PR-3 migrations are not registered in IDENTITY_MIGRATIONS');
}
const IC1_FILES = new Set([EXPAND, BACKFILL, CARDINALITY, IMMUTABLE]);
// Everything BEFORE the IC-1 files (the pre-PR-2 schema).
const PRE_IC1 = IDENTITY_MIGRATIONS.filter((p) => !IC1_FILES.has(p));
// Order check: the four IC-1 files are the LAST four, in PR order.
const sqlOf = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

// Production ids (IC-0 preflight shape): the platform sentinel tenant id is the
// libs/auth PLATFORM_TENANT_SENTINEL_ID; the other tenant stands in for Astre.
const SENTINEL = '01900000-0000-7000-8000-000000000100';
const ASTRE = '01900000-0000-7000-8000-0000000000a1';
const ROLE_OWNER = '01900000-0000-7000-8000-000000000014';

// Line-based splitters as they exist in the harness.
// (a) the regex form used by 15 identity consumers;
function regexSplit(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}
// (b) the NAIVE scanner (split on EVERY `;`) — the pre-PR-3 shape of the one
//     scanner consumer; it cannot carry a quoted plpgsql body;
function everySemicolonSplit(sql: string): string[] {
  return sql.replace(/--[^\n]*$/gm, '').split(';').map((s) => s.trim()).filter((s) => s.length > 0);
}
// (c) the QUOTE-AWARE scanner (the PR-3 shape of that consumer): a `;` inside a
//     single-quoted string never splits; `''` is the escaped quote.
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
        } else {
          inQuote = false;
        }
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      cur += ch;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      cur += ch;
      continue;
    }
    if (ch === ';') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.replace(/--[^\n]*$/gm, '').trim()).filter((s) => s.length > 0);
}

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'IC-1 PR-2/PR-3 — migration replay: expand, backfill, restrict and immutability on a production-shaped identity DB (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let adminUrl: string;
    const clients: Client[] = [];
    const prismas: PrismaService[] = [];

    // A fresh database with every identity migration BEFORE IC-1 applied (whole-
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
      for (const rel of PRE_IC1) await db.query(sqlOf(rel));
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

    // The PRE-PR-2 writer shape (a pre-PR-2 image): no tenant_id column named.
    async function oldImageInsertUser(db: Client, id: string, email: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, updated_at)
         VALUES ($1::uuid, $2, $3, true, now())`,
        [id, email, email],
      );
    }
    // The PR-2+ writer shape: born owned.
    async function ownedInsertUser(db: Client, id: string, email: string, tenant_id: string): Promise<void> {
      await db.query(
        `INSERT INTO identity."User" (id, email, display_name, is_active, tenant_id, updated_at)
         VALUES ($1::uuid, $2, $3, true, $4::uuid, now())`,
        [id, email, email, tenant_id],
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
    // The PR-3 restriction state, read from the catalog.
    async function restrictState(db: Client): Promise<{
      tenant_id_nullable: string;
      unique_user_id_index: number;
      composite_fk: number;
      composite_fk_validated: boolean | null;
      trigger_count: number;
    }> {
      const col = await db.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_schema = 'identity' AND table_name = 'User' AND column_name = 'tenant_id'`,
      );
      const idx = await db.query(
        `SELECT 1 FROM pg_indexes WHERE schemaname = 'identity' AND tablename = 'UserTenantMembership' AND indexname = 'UserTenantMembership_user_id_key'`,
      );
      const fk = await db.query<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = 'UserTenantMembership_user_id_tenant_id_fkey'`,
      );
      const trg = await db.query(
        `SELECT 1 FROM pg_trigger WHERE tgname = 'user_tenant_no_repoint' AND NOT tgisinternal`,
      );
      return {
        tenant_id_nullable: col.rows[0]?.is_nullable ?? 'MISSING',
        unique_user_id_index: idx.rowCount ?? 0,
        composite_fk: fk.rowCount ?? 0,
        composite_fk_validated: fk.rows[0]?.convalidated ?? null,
        trigger_count: trg.rowCount ?? 0,
      };
    }
    const UNRESTRICTED = {
      tenant_id_nullable: 'YES',
      unique_user_id_index: 0,
      composite_fk: 0,
      composite_fk_validated: null,
      trigger_count: 0,
    };

    // A database with PR-2 fully applied (expand + backfill) on a clean, owned
    // production shape — the starting point of every PR-3 case.
    async function pr2Db(name: string): Promise<{ db: Client; url: string; owner: string; superAdmin: string; invitee: string }> {
      const { db, url } = await freshDb(name);
      await seedTenantsAndRole(db);
      const owner = uuidv7();
      const superAdmin = uuidv7();
      const invitee = uuidv7();
      await oldImageInsertUser(db, owner, `owner@${name}.example`);
      await oldImageInsertUser(db, superAdmin, `platform.owner@${name}.example`);
      await oldImageInsertUser(db, invitee, `invitee@${name}.example`);
      await insertMembership(db, owner, ASTRE);
      await insertMembership(db, superAdmin, SENTINEL);
      await insertMembership(db, invitee, ASTRE, 'INVITED');
      await applyFileAsOneTransaction(db, EXPAND);
      await applyFileAsOneTransaction(db, BACKFILL);
      return { db, url, owner, superAdmin, invitee };
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

    it('registration order — the four IC-1 files are contiguous in PR order, after every pre-IC migration; only the IC-4 Tenant.kind migration follows them', () => {
      const i = IDENTITY_MIGRATIONS.indexOf(EXPAND);
      expect(i).toBeGreaterThan(0);
      expect(IDENTITY_MIGRATIONS.slice(i, i + 4)).toEqual([EXPAND, BACKFILL, CARDINALITY, IMMUTABLE]);
      // IC-4 PR-9 — the additive Tenant.kind migration is registered LAST (it
      // depends on nothing in IC-1 and nothing depends on it).
      const after = IDENTITY_MIGRATIONS.slice(i + 4);
      expect(after).toHaveLength(1);
      expect(after[0]).toMatch(/20261017000000_ic4_tenant_kind\/migration\.sql$/);
    });

    it('splitter safety (PR-2) — both files survive the regex splitter (4 + 2 statements) AND a split-on-every-semicolon scanner (no inner terminator, no $$)', () => {
      const expandSql = sqlOf(EXPAND);
      const backfillSql = sqlOf(BACKFILL);
      expect(regexSplit(expandSql)).toHaveLength(4);
      expect(regexSplit(backfillSql)).toHaveLength(2);
      expect(everySemicolonSplit(expandSql)).toHaveLength(4);
      expect(everySemicolonSplit(backfillSql)).toHaveLength(2);
      expect(expandSql).not.toContain('$$');
      expect(backfillSql).not.toContain('$$');
      expect(backfillSql).not.toMatch(/\bDO\b/);
    });

    it('splitter safety (PR-3) — cardinality (8) and immutable (3) survive the regex splitter and the QUOTE-AWARE scanner; the naive every-semicolon scanner breaks the quoted plpgsql body (why the scanner consumer was fixed)', () => {
      const cardSql = sqlOf(CARDINALITY);
      const immSql = sqlOf(IMMUTABLE);
      expect(regexSplit(cardSql)).toHaveLength(8);
      expect(quoteAwareSplit(cardSql)).toHaveLength(8);
      expect(everySemicolonSplit(cardSql)).toHaveLength(8);
      expect(cardSql).not.toContain('$$');
      expect(cardSql).not.toMatch(/\bDO\b/);
      expect(regexSplit(immSql)).toHaveLength(3);
      expect(quoteAwareSplit(immSql)).toHaveLength(3);
      expect(quoteAwareSplit(immSql)[0]).toMatch(/^CREATE OR REPLACE FUNCTION .* RETURN NEW; END'$/s);
      expect(everySemicolonSplit(immSql).length).toBeGreaterThan(3);
      expect(immSql).not.toContain('$$');
      expect(immSql).toContain('DROP TRIGGER IF EXISTS');
    });

    it('PR-2 SUCCESS (production shape) — 3 Users / 3 memberships / 2 Tenants → every User owned by its single membership tenant; super_admin → platform sentinel; re-run is a no-op', async () => {
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
      const before = await ownerMap(db);
      expect([...before.values()]).toEqual([null, null, null]);

      await applyFileAsOneTransaction(db, BACKFILL);
      const after = await ownerMap(db);
      expect(after.get(owner)).toBe(ASTRE);
      expect(after.get(superAdmin)).toBe(SENTINEL);
      expect(after.get(invitee)).toBe(ASTRE);
      const nulls = await db.query(`SELECT count(*)::int AS n FROM identity."User" WHERE tenant_id IS NULL`);
      expect(nulls.rows[0]?.n).toBe(0);

      await applyFileAsOneTransaction(db, BACKFILL);
      expect(await ownerMap(db)).toEqual(after);

      const prisma = new PrismaService(url);
      await prisma.$connect();
      prismas.push(prisma);
      const row = await prisma.user.findUnique({ where: { id: superAdmin }, include: { owner_tenant: true } });
      expect(row?.tenant_id).toBe(SENTINEL);
      expect(row?.owner_tenant?.name).toBe('Aramo Platform');
      await expect(
        db.query(`UPDATE identity."User" SET tenant_id = $1::uuid WHERE id = $2::uuid`, [uuidv7(), invitee]),
      ).rejects.toThrow(/User_tenant_id_fkey/);
    });

    it('PR-2 ABORT + ROLLBACK (multi-membership residue) — the backfill file raises with the governed message and NOTHING is assigned, not even for the clean Users', async () => {
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
      const after = await ownerMap(db);
      expect(after.get(clean)).toBeNull();
      expect(after.get(multi)).toBeNull();
      const ok = await db.query('SELECT 1 AS one');
      expect(ok.rows[0]?.one).toBe(1);
    });

    it('PR-2 ABORT + ROLLBACK (membership-less residue) — a User with no membership aborts the file the same way', async () => {
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

    it('PR-2 OLD/NEW COMPATIBILITY — after expand (+backfill) a pre-PR-2 writer still inserts and reads Users without naming the column; a repaired window row is owned by the backfill re-run; the column set is the 7 originals + tenant_id (nullable)', async () => {
      const { db, url } = await freshDb('ic1_compat');
      await seedTenantsAndRole(db);
      await applyFileAsOneTransaction(db, EXPAND);
      await applyFileAsOneTransaction(db, BACKFILL);

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

      // Read through pg (the regenerated client's non-null type would reject the
      // NULL window row — which is exactly why the restriction is Release B).
      const viaSql = await db.query<{ tenant_id: string | null }>(
        `SELECT tenant_id FROM identity."User" WHERE id = $1::uuid`,
        [legacy],
      );
      expect(viaSql.rows[0]?.tenant_id).toBeNull();

      await applyFileAsOneTransaction(db, BACKFILL);
      const prisma = new PrismaService(url);
      await prisma.$connect();
      prismas.push(prisma);
      expect((await prisma.user.findUnique({ where: { id: legacy } }))?.tenant_id).toBe(ASTRE);

      const cols = await db.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = 'identity' AND table_name = 'User' ORDER BY ordinal_position`,
      );
      expect(cols.rows.map((c) => c.column_name)).toEqual([
        'id', 'email', 'display_name', 'is_active', 'deactivated_at', 'created_at', 'updated_at', 'tenant_id',
      ]);
      expect(cols.rows.find((c) => c.column_name === 'tenant_id')?.is_nullable).toBe('YES');
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

    // ───────────────────────── PR-3 ─────────────────────────

    it('PR-3 SUCCESS (production shape after PR-2) — cardinality + immutable apply; NOT NULL, UNIQUE(user_id), VALIDATED composite FK and exactly one trigger are present; User_id_tenant_id_key is REUSED (not recreated); a pre-PR-2 writer is now REFUSED (Release B ordering)', async () => {
      const { db, url, owner } = await pr2Db('ic1_pr3_ok');
      expect(await restrictState(db)).toEqual(UNRESTRICTED);

      await applyFileAsOneTransaction(db, CARDINALITY);
      await applyFileAsOneTransaction(db, IMMUTABLE);
      expect(await restrictState(db)).toEqual({
        tenant_id_nullable: 'NO',
        unique_user_id_index: 1,
        composite_fk: 1,
        composite_fk_validated: true,
        trigger_count: 1,
      });
      // The PR-2 composite unique key is the FK target and exists exactly once.
      const target = await db.query(
        `SELECT 1 FROM pg_constraint WHERE conname = 'User_id_tenant_id_key' AND contype = 'u'`,
      );
      expect(target.rowCount).toBe(1);
      // Ownership unchanged by the restriction.
      const after = await ownerMap(db);
      expect(after.get(owner)).toBe(ASTRE);
      expect([...after.values()].every((v) => v !== null)).toBe(true);

      // The regenerated (non-null) client reads the restricted rows.
      const prisma = new PrismaService(url);
      await prisma.$connect();
      prismas.push(prisma);
      expect((await prisma.user.findUnique({ where: { id: owner } }))?.tenant_id).toBe(ASTRE);

      // A pre-PR-2 writer (no tenant_id) is REFUSED after the restriction — the
      // reason the eventual production release is two-step.
      await expect(oldImageInsertUser(db, uuidv7(), 'legacy.after.restrict@astre.example')).rejects.toThrow(
        /null value in column "tenant_id"/,
      );
      // A PR-2+ writer (born owned) with its single membership in the owner tenant succeeds.
      const fresh = uuidv7();
      await ownedInsertUser(db, fresh, 'fresh@astre.example', ASTRE);
      await insertMembership(db, fresh, ASTRE, 'INVITED');
      // Same-tenant lifecycle changes still succeed under the restriction.
      await db.query(`UPDATE identity."UserTenantMembership" SET invite_status = 'ACCEPTED' WHERE user_id = $1::uuid`, [fresh]);
      await db.query(`UPDATE identity."UserTenantMembership" SET invite_status = 'ACTIVE' WHERE user_id = $1::uuid`, [fresh]);
      await db.query(`UPDATE identity."UserTenantMembership" SET is_active = false, deactivated_at = now() WHERE user_id = $1::uuid`, [fresh]);
      await db.query(`UPDATE identity."UserTenantMembership" SET is_active = true, deactivated_at = NULL WHERE user_id = $1::uuid`, [fresh]);
      await db.query(`UPDATE identity."User" SET display_name = 'Fresh Renamed' WHERE id = $1::uuid`, [fresh]);
    });

    it('PR-3 ENFORCEMENT — second membership REFUSED (UNIQUE user_id); membership in a non-owner tenant REFUSED (composite FK); owner re-point REFUSED (trigger); owner-less User REFUSED (NOT NULL); a User with NO membership is ACCEPTED (at-least-one is the writers\' guarantee, not the database\'s)', async () => {
      const { db, owner } = await pr2Db('ic1_pr3_enforce');
      await applyFileAsOneTransaction(db, CARDINALITY);
      await applyFileAsOneTransaction(db, IMMUTABLE);

      await expect(insertMembership(db, owner, SENTINEL)).rejects.toThrow(/UserTenantMembership_user_id_key|UserTenantMembership_user_id_tenant_id_fkey/);
      const ownedNoMembership = uuidv7();
      await ownedInsertUser(db, ownedNoMembership, 'no.membership@astre.example', ASTRE); // accepted: at-most-one only
      await expect(insertMembership(db, ownedNoMembership, SENTINEL)).rejects.toThrow(/UserTenantMembership_user_id_tenant_id_fkey/);
      await insertMembership(db, ownedNoMembership, ASTRE); // the owner tenant: accepted
      await expect(
        db.query(`UPDATE identity."User" SET tenant_id = $1::uuid WHERE id = $2::uuid`, [SENTINEL, owner]),
      ).rejects.toThrow(/User\.tenant_id is immutable/);
      await expect(
        db.query(`INSERT INTO identity."User" (id, email, updated_at) VALUES ($1::uuid, 'ownerless@astre.example', now())`, [uuidv7()]),
      ).rejects.toThrow(/null value in column "tenant_id"/);
      const memberships = await db.query<{ user_id: string; n: string }>(
        `SELECT user_id, count(*)::text AS n FROM identity."UserTenantMembership" GROUP BY user_id HAVING count(*) > 1`,
      );
      expect(memberships.rows).toEqual([]);
    });

    it('PR-3 ABORT + ROLLBACK (unowned User) — the cardinality file raises at pre-validation 2 and the WHOLE file rolls back: no NOT NULL, no unique index, no FK; the earlier in-file backfill assignment of a clean window row does NOT survive', async () => {
      const { db } = await pr2Db('ic1_pr3_unowned');
      // Window rows: one repairable (single membership — step 1 would assign it),
      // one genuinely unowned (no membership — pre-validation 2 raises).
      const window = uuidv7();
      const orphan = uuidv7();
      await oldImageInsertUser(db, window, 'window@astre.example');
      await insertMembership(db, window, ASTRE);
      await oldImageInsertUser(db, orphan, 'orphan@astre.example');

      await expect(applyFileAsOneTransaction(db, CARDINALITY)).rejects.toThrow(
        /ic1 cardinality blocked: 1 User rows without tenant_id/,
      );
      expect(await restrictState(db)).toEqual(UNRESTRICTED);
      const after = await ownerMap(db);
      expect(after.get(window)).toBeNull(); // the in-file backfill assignment was rolled back
      expect(after.get(orphan)).toBeNull();
      const ok = await db.query('SELECT 1 AS one');
      expect(ok.rows[0]?.one).toBe(1);
    });

    it('PR-3 ABORT + ROLLBACK (multi-membership User) — pre-validation 3 raises and the WHOLE file rolls back', async () => {
      const { db } = await pr2Db('ic1_pr3_multi');
      const window = uuidv7();
      await oldImageInsertUser(db, window, 'window2@astre.example');
      await insertMembership(db, window, ASTRE);
      // An OWNED user with two memberships (passes pre-validation 2, fails 3).
      const multi = uuidv7();
      await ownedInsertUser(db, multi, 'multi2@astre.example', ASTRE);
      await insertMembership(db, multi, ASTRE);
      await insertMembership(db, multi, SENTINEL);

      await expect(applyFileAsOneTransaction(db, CARDINALITY)).rejects.toThrow(
        /ic1 cardinality blocked: 1 User rows with more than one membership/,
      );
      expect(await restrictState(db)).toEqual(UNRESTRICTED);
      expect((await ownerMap(db)).get(window)).toBeNull();
    });

    it('PR-3 ABORT + ROLLBACK (membership-owner mismatch) — pre-validation 4 raises and the WHOLE file rolls back', async () => {
      const { db } = await pr2Db('ic1_pr3_mismatch');
      const window = uuidv7();
      await oldImageInsertUser(db, window, 'window3@astre.example');
      await insertMembership(db, window, ASTRE);
      // An OWNED user whose single membership is in a DIFFERENT tenant.
      const mismatch = uuidv7();
      await ownedInsertUser(db, mismatch, 'mismatch@astre.example', ASTRE);
      await insertMembership(db, mismatch, SENTINEL);

      await expect(applyFileAsOneTransaction(db, CARDINALITY)).rejects.toThrow(
        /ic1 cardinality blocked: 1 memberships whose tenant differs from the owner tenant/,
      );
      expect(await restrictState(db)).toEqual(UNRESTRICTED);
      expect((await ownerMap(db)).get(window)).toBeNull();
    });

    it('PR-3 TRIGGER REPLAY — the immutable file applied twice yields exactly ONE trigger and no error; the raise still fires; dropping trigger + function is a clean rollback', async () => {
      const { db, owner } = await pr2Db('ic1_pr3_replay');
      await applyFileAsOneTransaction(db, CARDINALITY);
      await applyFileAsOneTransaction(db, IMMUTABLE);
      await applyFileAsOneTransaction(db, IMMUTABLE);
      expect((await restrictState(db)).trigger_count).toBe(1);
      await expect(
        db.query(`UPDATE identity."User" SET tenant_id = $1::uuid WHERE id = $2::uuid`, [SENTINEL, owner]),
      ).rejects.toThrow(/User\.tenant_id is immutable/);
      // Rollback of the immutability layer is schema-safe.
      await db.query(`DROP TRIGGER "user_tenant_no_repoint" ON identity."User"`);
      await db.query(`DROP FUNCTION identity.user_tenant_immutable()`);
      expect((await restrictState(db)).trigger_count).toBe(0);
    });
  },
);
