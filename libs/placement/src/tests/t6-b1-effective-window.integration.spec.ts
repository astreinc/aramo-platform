import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';

// Track 6 / T6-B1 — Effective-Window Substrate proofs against real Postgres 17.
// Covers directive §12: historical immutability, governed effective_to first-close,
// tenant-reset independence, interval CHECK, btree_gist overlap exclusion, the
// canonical as-of resolver, and migration execution (the btree_gist EXCLUDE builds).
// AssignmentRateVersion has UUID-only refs and no FK, so synthetic rows are inserted
// directly — the constraints/trigger under test are DB-level, not flow-level.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
  '20260815120000_t7_p2_falloff_remedy',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

// Dollar-quote-aware, line-comment-blind splitter (the migrations keep every line
// comment free of the terminator and of the dollar-quote delimiter).
function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inDollar = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql.startsWith('$$', i)) { inDollar = !inDollar; cur += '$$'; i += 1; continue; }
    if (sql[i] === ';' && !inDollar) { out.push(cur); cur = ''; } else cur += sql[i];
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const OVERLAP_CONSTRAINT = 'AssignmentRateVersion_no_window_overlap_excl';
// Fixed, ordered instants — resolver tests use explicit asOf so they never depend on
// wall-clock now. T0 < T1 < T2 < T3.
const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-02-01T00:00:00.000Z';
const T2 = '2026-03-01T00:00:00.000Z';
const T3 = '2026-04-01T00:00:00.000Z';

const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T6-B1 effective-window substrate (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let client: PrismaService;
    let repo: PlacementRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      client = new PrismaService(container.getConnectionUri());
      await client.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length > 0) await client.$executeRawUnsafe(t);
        }
      }
      repo = new PlacementRepository(client);
    }, 120_000);

    afterAll(async () => {
      await client?.$disconnect();
      await container?.stop();
    });

    // Insert a synthetic AssignmentRateVersion row directly. Fields not supplied
    // default to a valid fixed shape (80.00 / 120.50 / USD / HOURLY).
    async function insertVersion(o: {
      tenant_id: string;
      contract_assignment_id: string;
      effective_from: string;
      effective_to?: string | null;
      cancelled_at?: string | null;
      id?: string;
      requisition_id?: string;
      talent_record_id?: string;
    }): Promise<string> {
      const id = o.id ?? randomUUID();
      await client.$executeRawUnsafe(
        `INSERT INTO placement."AssignmentRateVersion"
           (id, tenant_id, contract_assignment_id, requisition_id, talent_record_id,
            pay_rate_amount, bill_rate_amount, currency, rate_period,
            effective_from, effective_to, recorded_by, cancelled_at)
         VALUES ('${id}','${o.tenant_id}','${o.contract_assignment_id}',
            '${o.requisition_id ?? randomUUID()}','${o.talent_record_id ?? randomUUID()}',
            80.00, 120.50, 'USD', 'HOURLY',
            '${o.effective_from}', ${q(o.effective_to ?? null)}, '${randomUUID()}', ${q(o.cancelled_at ?? null)})`,
      );
      return id;
    }

    async function insertAssignment(o: {
      tenant_id: string;
      placement_process_id: string;
      id: string;
      requisition_id: string;
      talent_record_id: string;
    }): Promise<void> {
      await client.$executeRawUnsafe(
        `INSERT INTO placement."ContractAssignment"
           (id, tenant_id, placement_process_id, submittal_id, requisition_id, talent_record_id, started_at, provenance)
         VALUES ('${o.id}','${o.tenant_id}','${o.placement_process_id}','${randomUUID()}',
            '${o.requisition_id}','${o.talent_record_id}','${T0}','BACKFILLED')`,
      );
    }

    // Run `SET LOCAL <marker> = <value>` then `UPDATE ...` in one interactive tx so
    // the transaction-local GUC governs the UPDATE. Returns the affected-row count.
    async function updateUnderMarker(sql: string, marker?: { name: string; value: string }): Promise<number> {
      return client.$transaction(async (tx) => {
        if (marker) await tx.$executeRawUnsafe(`SET LOCAL ${marker.name} = '${marker.value}'`);
        return tx.$executeRawUnsafe(sql);
      });
    }
    const REVISION = { name: 'app.assignment_commercial_revision', value: 'authorized' };

    // ---- §12.7 migration execution: the btree_gist EXCLUDE + extension built ----
    it('§12.7 — btree_gist extension and the overlap EXCLUDE constraint exist', async () => {
      const ext = await client.$queryRawUnsafe<Array<{ extname: string }>>(
        `SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`,
      );
      expect(ext).toHaveLength(1);
      const con = await client.$queryRawUnsafe<Array<{ conname: string }>>(
        `SELECT conname FROM pg_constraint WHERE conname = '${OVERLAP_CONSTRAINT}'`,
      );
      expect(con).toHaveLength(1);
    });

    // ---- §12.4 interval CHECK ----
    describe('§12.4 interval validity CHECK', () => {
      it('effective_to == effective_from is refused', async () => {
        const t = randomUUID();
        await expect(
          insertVersion({ tenant_id: t, contract_assignment_id: randomUUID(), effective_from: T1, effective_to: T1 }),
        ).rejects.toThrow();
      });
      it('effective_to < effective_from is refused', async () => {
        const t = randomUUID();
        await expect(
          insertVersion({ tenant_id: t, contract_assignment_id: randomUUID(), effective_from: T2, effective_to: T1 }),
        ).rejects.toThrow();
      });
      it('effective_to > effective_from is accepted', async () => {
        const t = randomUUID();
        await expect(
          insertVersion({ tenant_id: t, contract_assignment_id: randomUUID(), effective_from: T1, effective_to: T2 }),
        ).resolves.toBeDefined();
      });
    });

    // ---- §12.5 exclusion invariant ----
    describe('§12.5 overlap exclusion (non-cancelled)', () => {
      it('exact overlap refused', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T2 });
        await expect(insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T2 })).rejects.toThrow();
      });
      it('partial overlap refused', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T2 });
        await expect(insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: T3 })).rejects.toThrow();
      });
      it('contained overlap refused', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T3 });
        await expect(insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: T2 })).rejects.toThrow();
      });
      it('open-ended overlap refused', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: null });
        await expect(insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: null })).rejects.toThrow();
      });
      it('adjacent half-open windows accepted', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T1 });
        await expect(insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: T2 })).resolves.toBeDefined();
      });
      it('different assignments may overlap', async () => {
        const tenant = randomUUID();
        await insertVersion({ tenant_id: tenant, contract_assignment_id: randomUUID(), effective_from: T0, effective_to: T2 });
        await expect(insertVersion({ tenant_id: tenant, contract_assignment_id: randomUUID(), effective_from: T0, effective_to: T2 })).resolves.toBeDefined();
      });
      it('different tenants may overlap', async () => {
        const ca = randomUUID();
        await insertVersion({ tenant_id: randomUUID(), contract_assignment_id: ca, effective_from: T0, effective_to: T2 });
        await expect(insertVersion({ tenant_id: randomUUID(), contract_assignment_id: ca, effective_from: T0, effective_to: T2 })).resolves.toBeDefined();
      });
      it('a cancelled version does not reserve its window (overlap predicate excludes it)', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        // A cancelled [T0,T2) must not block a new non-cancelled window that OVERLAPS it.
        // A distinct effective_from is used so this isolates the partial EXCLUDE from the
        // (non-partial) same-effective_from unique key, which B1 deliberately preserves
        // (§7.3) — a cancelled row still holds its exact effective_from under that key.
        await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T2, cancelled_at: T1 });
        await expect(insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: T3 })).resolves.toBeDefined();
      });
    });

    // ---- §12.1 historical immutability (ordinary UPDATE with no marker) ----
    describe('§12.1 historical immutability', () => {
      const fields: Array<[string, string]> = [
        ['pay_rate_amount', '999.99'],
        ['bill_rate_amount', '999.99'],
        ["currency", "'EUR'"],
        ["rate_period", "'DAILY'"],
        ['effective_from', `'${T0}'`],
        ['recorded_by', `'${randomUUID()}'`],
        ["change_reason", "'edited'"],
      ];
      for (const [col, val] of fields) {
        it(`ordinary UPDATE of ${col} is rejected`, async () => {
          const tenant = randomUUID(); const ca = randomUUID();
          const id = await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: null });
          await expect(
            client.$executeRawUnsafe(`UPDATE placement."AssignmentRateVersion" SET ${col} = ${val} WHERE id = '${id}'`),
          ).rejects.toThrow();
          const row = await client.assignmentRateVersion.findFirstOrThrow({ where: { id } });
          expect(row.effective_to).toBeNull();
        });
      }
    });

    // ---- §12.2 governed effective_to first-close ----
    describe('§12.2 governed effective_to first-close', () => {
      async function seedOpen(): Promise<{ id: string; tenant: string; ca: string }> {
        const tenant = randomUUID(); const ca = randomUUID();
        const id = await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: null });
        return { id, tenant, ca };
      }
      const closeSql = (id: string, to: string) => `UPDATE placement."AssignmentRateVersion" SET effective_to = '${to}' WHERE id = '${id}'`;

      it('marker absent — NULL→T is refused', async () => {
        const { id } = await seedOpen();
        await expect(updateUnderMarker(closeSql(id, T2))).rejects.toThrow();
      });
      it('wrong marker value — NULL→T is refused', async () => {
        const { id } = await seedOpen();
        await expect(updateUnderMarker(closeSql(id, T2), { name: REVISION.name, value: 'on' })).rejects.toThrow();
      });
      it('authorized NULL→valid T succeeds', async () => {
        const { id } = await seedOpen();
        await expect(updateUnderMarker(closeSql(id, T2), REVISION)).resolves.toBe(1);
        const row = await client.assignmentRateVersion.findFirstOrThrow({ where: { id } });
        expect(row.effective_to?.toISOString()).toBe(new Date(T2).toISOString());
      });
      it('authorized close with an unrelated column change is refused', async () => {
        const { id } = await seedOpen();
        await expect(
          updateUnderMarker(
            `UPDATE placement."AssignmentRateVersion" SET effective_to = '${T2}', pay_rate_amount = 999.99 WHERE id = '${id}'`,
            REVISION,
          ),
        ).rejects.toThrow();
      });
      it('authorized effective_from change is refused', async () => {
        const { id } = await seedOpen();
        await expect(
          updateUnderMarker(`UPDATE placement."AssignmentRateVersion" SET effective_from = '${T0}' WHERE id = '${id}'`, REVISION),
        ).rejects.toThrow();
      });
      it('second close (T1→T2) is refused', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        const id = await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T1 });
        await expect(updateUnderMarker(closeSql(id, T2), REVISION)).rejects.toThrow();
      });
      it('reopen (T→NULL) is refused', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        const id = await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T0, effective_to: T1 });
        await expect(
          updateUnderMarker(`UPDATE placement."AssignmentRateVersion" SET effective_to = NULL WHERE id = '${id}'`, REVISION),
        ).rejects.toThrow();
      });
      it('no-op (NULL→NULL) is refused', async () => {
        const { id } = await seedOpen();
        await expect(
          updateUnderMarker(`UPDATE placement."AssignmentRateVersion" SET effective_to = NULL WHERE id = '${id}'`, REVISION),
        ).rejects.toThrow();
      });
      it('close boundary at or before effective_from is refused', async () => {
        const { id } = await seedOpen(); // effective_from = T1
        await expect(updateUnderMarker(closeSql(id, T1), REVISION)).rejects.toThrow();
        await expect(updateUnderMarker(closeSql(id, T0), REVISION)).rejects.toThrow();
      });
    });

    // ---- §12.3 tenant-reset independence ----
    describe('§12.3 tenant-reset', () => {
      it('tenant-reset DELETE still succeeds under its marker', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        const id = await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: null });
        const affected = await updateUnderMarker(
          `DELETE FROM placement."AssignmentRateVersion" WHERE id = '${id}'`,
          { name: 'app.tenant_reset', value: 'authorized' },
        );
        expect(affected).toBe(1);
      });
      it('the revision marker alone does not authorize DELETE', async () => {
        const tenant = randomUUID(); const ca = randomUUID();
        const id = await insertVersion({ tenant_id: tenant, contract_assignment_id: ca, effective_from: T1, effective_to: null });
        await expect(
          updateUnderMarker(`DELETE FROM placement."AssignmentRateVersion" WHERE id = '${id}'`, REVISION),
        ).rejects.toThrow();
      });
    });

    // ---- §12.6 canonical as-of resolver ----
    describe('§12.6 as-of resolver', () => {
      async function scenario(): Promise<{ tenant: string; ppid: string; caId: string }> {
        const tenant = randomUUID();
        const ppid = randomUUID();
        const caId = randomUUID();
        await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: caId, requisition_id: randomUUID(), talent_record_id: randomUUID() });
        return { tenant, ppid, caId };
      }

      it('no version → null', async () => {
        const s = await scenario();
        expect(await repo.findAssignmentCommercialProjection(s.tenant, s.ppid, 'x', new Date(T2))).toBeNull();
      });

      it('current open version resolves at now-default and by explicit asOf', async () => {
        const s = await scenario();
        const vid = await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.caId, effective_from: T0, effective_to: null });
        const view = await repo.findAssignmentCommercialProjection(s.tenant, s.ppid, 'x', new Date(T2));
        expect(view?.assignment_rate_version_id).toBe(vid);
        expect(view?.contract_assignment_id).toBe(s.caId);
      });

      it('historical asOf selects the past closed window; later asOf selects the open successor', async () => {
        const s = await scenario();
        const past = await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.caId, effective_from: T0, effective_to: T2 });
        const current = await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.caId, effective_from: T2, effective_to: null });
        expect((await repo.findAssignmentCommercialProjection(s.tenant, s.ppid, 'x', new Date(T1)))?.assignment_rate_version_id).toBe(past);
        expect((await repo.findAssignmentCommercialProjection(s.tenant, s.ppid, 'x', new Date(T3)))?.assignment_rate_version_id).toBe(current);
      });

      it('a future version is excluded for an earlier asOf', async () => {
        const s = await scenario();
        await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.caId, effective_from: T2, effective_to: null });
        expect(await repo.findAssignmentCommercialProjection(s.tenant, s.ppid, 'x', new Date(T0))).toBeNull();
      });

      it('a cancelled version is excluded', async () => {
        const s = await scenario();
        await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.caId, effective_from: T0, effective_to: null, cancelled_at: T1 });
        expect(await repo.findAssignmentCommercialProjection(s.tenant, s.ppid, 'x', new Date(T2))).toBeNull();
      });

      // §10 / §12.6 — the defensive fail-closed proof survives the constraint via a
      // scoped, self-restoring DDL window: drop the EXCLUDE, inject a corrupt overlap,
      // prove the resolver fails closed, then delete the injected rows (tenant-reset
      // escape) and re-add the constraint in finally. No production bypass exists.
      it('legacy/corrupt overlap still fails closed (INTERNAL_ERROR)', async () => {
        const s = await scenario();
        await client.$executeRawUnsafe(`ALTER TABLE placement."AssignmentRateVersion" DROP CONSTRAINT "${OVERLAP_CONSTRAINT}"`);
        try {
          await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.caId, effective_from: T0, effective_to: null });
          await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.caId, effective_from: T1, effective_to: null });
          await expect(
            repo.findAssignmentCommercialProjection(s.tenant, s.ppid, 'x', new Date(T2)),
          ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 500 });
        } finally {
          await client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL app.tenant_reset = 'authorized'`);
            await tx.$executeRawUnsafe(`DELETE FROM placement."AssignmentRateVersion" WHERE tenant_id = '${s.tenant}'`);
          });
          await client.$executeRawUnsafe(
            `ALTER TABLE placement."AssignmentRateVersion"
               ADD CONSTRAINT "${OVERLAP_CONSTRAINT}" EXCLUDE USING gist (
                 "tenant_id" public.gist_uuid_ops WITH =,
                 "contract_assignment_id" public.gist_uuid_ops WITH =,
                 tstzrange("effective_from", COALESCE("effective_to", 'infinity'), '[)') WITH &&
               ) WHERE ("cancelled_at" IS NULL)`,
          );
        }
      });
    });
  },
);
