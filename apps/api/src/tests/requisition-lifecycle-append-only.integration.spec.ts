import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Client } from 'pg';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// L1-F1 (Aramo-Requisition-Lane1-F-Hardening-Directive-v1_0-LOCKED) — the
// DB-LAYER append-only enforcement on requisition.RequisitionLifecycleEvent.
// Migration 20260827120000 installs BEFORE UPDATE / BEFORE DELETE triggers that
// RAISE check_violation, with an EXACT-VALUE governed tenant-reset escape on
// DELETE only. This spec drives those triggers with RAW SQL (independent of the
// store/repo) so the guarantee is proven at the database boundary. It uses the
// GLOB migration harness (readdirSync over the requisition migrations dir), so
// the new migration is applied automatically with no curated-list edit. Lives in
// apps/api (an integration ROOT). Skipped unless ARAMO_RUN_INTEGRATION=1.

const ROOT = resolve(__dirname, '../../../..');
const TENANT = '01900000-0000-7000-8000-0000000000f1';
const CHECK_VIOLATION = '23514'; // SQLSTATE for ERRCODE = 'check_violation'

function migrationsFor(lib: string): string[] {
  const dir = resolve(ROOT, `libs/${lib}/prisma/migrations`);
  return readdirSync(dir)
    .filter((n) => /^\d/.test(n))
    .sort()
    .map((n) => resolve(dir, n, 'migration.sql'));
}
const MIGRATIONS = [...migrationsFor('requisition')];

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'RequisitionLifecycleEvent — DB append-only enforcement (L1-F1) — real Postgres 17',
  () => {
    let container: StartedPostgreSqlContainer;
    let db: Client;

    // Seed one lifecycle-event row and return its id. previous_status is
    // deliberately left NULL for one seeded row to exercise the wholesale
    // reject-UPDATE across a nullable column (the NULL=NULL trap the directive
    // calls out — a per-column OLD=NEW trigger would misbehave here).
    async function seedEvent(previousNull = false): Promise<string> {
      const id = uuidv7();
      await db.query(
        `INSERT INTO requisition."RequisitionLifecycleEvent"
           (id, tenant_id, requisition_id, previous_status, next_status, actor_id, origin, reason_code, correlation_id)
         VALUES ($1, $2, $3, ${previousNull ? 'NULL' : `'open'`}, 'on_hold', 'actor-1', 'ui', 'SEED', $4)`,
        [id, TENANT, uuidv7(), uuidv7()],
      );
      return id;
    }

    async function reasonCode(id: string): Promise<string | null> {
      const { rows } = await db.query(
        `SELECT reason_code FROM requisition."RequisitionLifecycleEvent" WHERE id = $1`,
        [id],
      );
      return rows[0]?.reason_code ?? null;
    }

    async function rowCount(id: string): Promise<number> {
      const { rows } = await db.query(
        `SELECT count(*)::int AS n FROM requisition."RequisitionLifecycleEvent" WHERE id = $1`,
        [id],
      );
      return rows[0].n;
    }

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      db = new Client({ connectionString: container.getConnectionUri() });
      await db.connect();
      for (const p of MIGRATIONS) await db.query(readFileSync(p, 'utf8'));
    }, 120_000);

    afterAll(async () => {
      await db?.end();
      await container?.stop();
    }, 60_000);

    // Every test that leaves the DB in a transaction-aborted state must reset it.
    beforeEach(async () => {
      await db.query('ROLLBACK').catch(() => undefined);
    });

    it('F1-1: an ordinary UPDATE is rejected (check_violation) and the row is UNCHANGED', async () => {
      const id = await seedEvent();
      // Non-vacuous BEFORE: the seeded value genuinely exists.
      expect(await reasonCode(id)).toBe('SEED');

      let caught: unknown;
      try {
        await db.query(
          `UPDATE requisition."RequisitionLifecycleEvent" SET reason_code = 'TAMPERED' WHERE id = $1`,
          [id],
        );
      } catch (err) {
        caught = err;
      }
      await db.query('ROLLBACK').catch(() => undefined);
      expect((caught as { code?: string } | undefined)?.code).toBe(CHECK_VIOLATION);

      // EXACT after: still the seeded value — the UPDATE never took effect.
      expect(await reasonCode(id)).toBe('SEED');
    });

    it('F1-1b: the wholesale reject-UPDATE fires even for a row with a NULL previous_status (no NULL=NULL trap)', async () => {
      const id = await seedEvent(true); // previous_status NULL
      let caught: unknown;
      try {
        await db.query(
          `UPDATE requisition."RequisitionLifecycleEvent" SET next_status = 'closed' WHERE id = $1`,
          [id],
        );
      } catch (err) {
        caught = err;
      }
      await db.query('ROLLBACK').catch(() => undefined);
      expect((caught as { code?: string } | undefined)?.code).toBe(CHECK_VIOLATION);
      // The next_status is unchanged.
      const { rows } = await db.query(
        `SELECT next_status FROM requisition."RequisitionLifecycleEvent" WHERE id = $1`,
        [id],
      );
      expect(rows[0].next_status).toBe('on_hold');
    });

    it('F1-2: an ordinary DELETE (no reset escape) is rejected and the row SURVIVES', async () => {
      const id = await seedEvent();
      expect(await rowCount(id)).toBe(1);

      let caught: unknown;
      try {
        await db.query(
          `DELETE FROM requisition."RequisitionLifecycleEvent" WHERE id = $1`,
          [id],
        );
      } catch (err) {
        caught = err;
      }
      await db.query('ROLLBACK').catch(() => undefined);
      expect((caught as { code?: string } | undefined)?.code).toBe(CHECK_VIOLATION);

      // The row survives the rejected DELETE.
      expect(await rowCount(id)).toBe(1);
    });

    it('F1-3 (escape): a governed tenant-reset (app.tenant_reset = authorized) permits DELETE', async () => {
      const id = await seedEvent();
      await db.query('BEGIN');
      await db.query(`SET LOCAL app.tenant_reset = 'authorized'`);
      const res = await db.query(
        `DELETE FROM requisition."RequisitionLifecycleEvent" WHERE id = $1`,
        [id],
      );
      await db.query('COMMIT');
      expect(res.rowCount).toBe(1);
      expect(await rowCount(id)).toBe(0); // genuinely gone
    });

    it('F1-3b (exact-value): a NON-authorized GUC value does NOT escape — DELETE is still rejected', async () => {
      const id = await seedEvent();
      let caught: unknown;
      try {
        await db.query('BEGIN');
        await db.query(`SET LOCAL app.tenant_reset = 'yes'`); // truthy but NOT 'authorized'
        await db.query(
          `DELETE FROM requisition."RequisitionLifecycleEvent" WHERE id = $1`,
          [id],
        );
        await db.query('COMMIT');
      } catch (err) {
        caught = err;
      }
      await db.query('ROLLBACK').catch(() => undefined);
      expect((caught as { code?: string } | undefined)?.code).toBe(CHECK_VIOLATION);
      // Exact-value comparison held: the row survives a non-authorized value.
      expect(await rowCount(id)).toBe(1);
    });
  },
);
