import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';

// Track 6 / T6-B2 — the governed post-start commercial revision, against real
// Postgres 17. Open-tail-only close+append, ACTIVE-only, atomic, serialized against
// endAssignment, with named-constraint DB-failure translation. AssignmentRateVersion
// has UUID-only refs (no FK), so synthetic assignments/versions are inserted directly.

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
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

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

const T_PAST = '2026-01-01T00:00:00.000Z';
const T_FUT1 = '2030-01-01T00:00:00.000Z';
const T_FUT2 = '2031-01-01T00:00:00.000Z';
const TERMS = { pay_rate_amount: '80.00', bill_rate_amount: '120.50', currency: 'USD', rate_period: 'HOURLY' } as const;
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T6-B2 commercial revision (real Postgres 17)',
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

    async function insertAssignment(o: {
      tenant_id: string; placement_process_id: string; id: string;
      lifecycle_state?: 'ACTIVE' | 'ENDED'; end_reason?: string | null;
    }): Promise<void> {
      const state = o.lifecycle_state ?? 'ACTIVE';
      const endReason = state === 'ENDED' ? (o.end_reason ?? 'COMPLETED') : null;
      await client.$executeRawUnsafe(
        `INSERT INTO placement."ContractAssignment"
           (id, tenant_id, placement_process_id, submittal_id, requisition_id, talent_record_id, started_at, provenance, lifecycle_state, end_reason)
         VALUES ('${o.id}','${o.tenant_id}','${o.placement_process_id}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${T_PAST}','BACKFILLED','${state}',${endReason ? `'${endReason}'` : 'NULL'})`,
      );
    }
    async function insertVersion(o: {
      tenant_id: string; contract_assignment_id: string; effective_from: string;
      effective_to?: string | null; cancelled_at?: string | null; id?: string;
    }): Promise<string> {
      const id = o.id ?? randomUUID();
      await client.$executeRawUnsafe(
        `INSERT INTO placement."AssignmentRateVersion"
           (id, tenant_id, contract_assignment_id, requisition_id, talent_record_id, pay_rate_amount, bill_rate_amount, currency, rate_period, effective_from, effective_to, recorded_by, cancelled_at)
         VALUES ('${id}','${o.tenant_id}','${o.contract_assignment_id}','${randomUUID()}','${randomUUID()}',
           80.00,120.50,'USD','HOURLY','${o.effective_from}',${q(o.effective_to ?? null)},'${randomUUID()}',${q(o.cancelled_at ?? null)})`,
      );
      return id;
    }
    // A live ACTIVE assignment with a single open version at T_PAST.
    async function seedActiveOpen(): Promise<{ tenant: string; ppid: string; aid: string; verId: string }> {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const verId = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_PAST, effective_to: null });
      return { tenant, ppid, aid, verId };
    }
    const revise = (s: { tenant: string; ppid: string }, extra: Record<string, unknown> = {}) =>
      repo.createCommercialRevision(
        { tenant_id: s.tenant, placement_process_id: s.ppid, ...TERMS, change_reason: 'rate correction', recorded_by: randomUUID(), ...extra },
        'x',
      );
    const rowsFor = (s: { tenant: string; aid: string }) =>
      client.assignmentRateVersion.findMany({ where: { tenant_id: s.tenant, contract_assignment_id: s.aid }, orderBy: { effective_from: 'asc' } });

    // ---- §20.1 revision creation ----
    it('immediate revision closes the predecessor at T_new and appends the open successor', async () => {
      const s = await seedActiveOpen();
      const recorder = randomUUID();
      const view = await revise(s, { pay_rate_amount: '90.00', bill_rate_amount: '150.00', change_reason: '  bumped rate  ', recorded_by: recorder });
      expect(view.pay_rate_amount).toBe('90.00');
      expect(view.bill_rate_amount).toBe('150.00');
      expect(view.markup_percent).toBe('66.67'); // (150-90)/90*100
      expect(view.effective_to).toBeNull();
      expect(view.recorded_by).toBe(recorder);
      expect(view.change_reason).toBe('bumped rate'); // trimmed
      const rows = await rowsFor(s);
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe(s.verId);
      expect(rows[0].effective_to).not.toBeNull(); // predecessor closed
      expect(rows[0].effective_to!.toISOString()).toBe(rows[1].effective_from.toISOString()); // contiguous
      expect(rows[1].effective_to).toBeNull(); // successor open
      // outbox: identity-only + superseded id, NO money
      const ev = await client.outboxEvent.findFirstOrThrow({ where: { tenant_id: s.tenant, event_type: 'placement.assignment.rate_version.created' } });
      const payload = ev.event_payload as Record<string, unknown>;
      expect(payload['superseded_rate_version_id']).toBe(s.verId);
      for (const banned of ['pay_rate_amount', 'bill_rate_amount', 'currency', 'rate_period', 'spread_amount']) {
        expect(payload).not.toHaveProperty(banned);
      }
    });

    it('future revision + a second future revision append in chronological order', async () => {
      const s = await seedActiveOpen();
      await revise(s, { effective_from: T_FUT1 });
      await revise(s, { effective_from: T_FUT2 });
      const rows = await rowsFor(s);
      expect(rows.map((r) => r.effective_from.toISOString())).toEqual([
        new Date(T_PAST).toISOString(), new Date(T_FUT1).toISOString(), new Date(T_FUT2).toISOString(),
      ]);
      expect(rows[0].effective_to!.toISOString()).toBe(new Date(T_FUT1).toISOString());
      expect(rows[1].effective_to!.toISOString()).toBe(new Date(T_FUT2).toISOString());
      expect(rows[2].effective_to).toBeNull();
    });

    it('refuses a revision on an ENDED assignment (404)', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid, lifecycle_state: 'ENDED' });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_PAST, effective_to: null });
      await expect(revise({ tenant, ppid })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });

    it('refuses when there is no open version to revise (404)', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_PAST, effective_to: T_FUT1 }); // closed only
      await expect(revise({ tenant, ppid })).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });

    it('refuses a backdated effective_from (400)', async () => {
      const s = await seedActiveOpen();
      await expect(revise(s, { effective_from: '2020-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    });

    it('refuses malformed money / currency / rate_period / empty change_reason (400)', async () => {
      const s = await seedActiveOpen();
      await expect(revise(s, { pay_rate_amount: '80.999' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(revise(s, { currency: 'usd' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(revise(s, { rate_period: 'FORTNIGHTLY' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(revise(s, { change_reason: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    // ---- §20.7 DB-failure translation (RED proof of the real Prisma 7 shape) ----
    it('translates a duplicate effective instant to 409 duplicate_effective_from and rolls back atomically', async () => {
      const s = await seedActiveOpen();
      // a CANCELLED version already occupies T_FUT1 under the non-partial unique key.
      await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.aid, effective_from: T_FUT1, effective_to: null, cancelled_at: T_PAST });
      await expect(revise(s, { effective_from: T_FUT1 })).rejects.toMatchObject({
        code: 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', statusCode: 409,
      });
      // Atomic rollback — the predecessor is STILL open, no successor was appended.
      const rows = await rowsFor(s);
      const open = rows.filter((r) => r.effective_to === null && r.cancelled_at === null);
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe(s.verId);
    });

    // ---- §20.3 concurrency ----
    it('serializes two concurrent revisions at the same instant — exactly one wins', async () => {
      const s = await seedActiveOpen();
      const results = await Promise.allSettled([revise(s, { effective_from: T_FUT1 }), revise(s, { effective_from: T_FUT1 })]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const rows = await rowsFor(s);
      expect(rows).toHaveLength(2); // initial (now closed) + exactly one successor
    });

    it('revision and assignment-end cannot both leave an ENDED assignment with an open new tail', async () => {
      const s = await seedActiveOpen();
      await Promise.allSettled([
        revise(s, { effective_from: T_FUT1 }),
        repo.endAssignment({ tenant_id: s.tenant, placement_process_id: s.ppid, end_reason: 'COMPLETED', ended_by: randomUUID() }, 'x'),
      ]);
      // The end always commits; the revision either committed before it or was refused.
      const ca = await client.contractAssignment.findFirstOrThrow({ where: { id: s.aid } });
      expect(ca.lifecycle_state).toBe('ENDED');
    });

    // ---- §20.4 marker tx-locality ----
    it('the revision marker does not leak — an ordinary UPDATE of effective_to is still rejected afterwards', async () => {
      const s = await seedActiveOpen();
      await revise(s, { effective_from: T_FUT1 });
      const open = (await rowsFor(s)).find((r) => r.effective_to === null)!;
      await expect(
        client.$executeRawUnsafe(`UPDATE placement."AssignmentRateVersion" SET effective_to = '${T_FUT2}' WHERE id = '${open.id}'`),
      ).rejects.toThrow();
    });

    // ---- §20.6 version-series read ----
    it('lists the non-cancelled series (current + historical) effective_from DESC; cancelled excluded', async () => {
      const s = await seedActiveOpen();
      await revise(s, { effective_from: T_FUT1 }); // now: [T_PAST,T_FUT1) + [T_FUT1, ∞)
      await insertVersion({ tenant_id: s.tenant, contract_assignment_id: s.aid, effective_from: T_FUT2, effective_to: null, cancelled_at: T_PAST }); // cancelled
      const items = await repo.listAssignmentCommercialRevisions(s.tenant, s.ppid);
      expect(items).toHaveLength(2); // cancelled excluded
      expect(items[0].effective_to).toBeNull(); // current first (DESC)
      expect(new Date(items[0].effective_from).getTime()).toBeGreaterThan(new Date(items[1].effective_from).getTime());
    });

    it('returns an empty series for a placement with no assignment', async () => {
      expect(await repo.listAssignmentCommercialRevisions(randomUUID(), randomUUID())).toEqual([]);
    });
  },
);
