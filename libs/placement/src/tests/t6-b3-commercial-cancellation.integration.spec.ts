import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementRepository } from '../lib/placement.repository.js';

// Track 6 / T6-B3 — future-revision cancellation + assignment-END commercial
// reconciliation, against real Postgres 17. Covers: the extended ARV trigger truth
// table (cancellation + future-only re-open branches, both governed markers, tenant-
// reset independence), explicit cancellation eligibility + continuity, the §17 END
// interval matrix, same-instant reservation, atomicity (forced rollback), and the §19
// concurrency races. AssignmentRateVersion has UUID-only refs (no FK), so synthetic
// assignments/versions are inserted directly.
//
// The two governed capability markers are referenced here as raw literals BY DESIGN
// (this file is in both marker-confinement allowlists) to prove the trigger truth
// table directly. Production code never sets them outside PlacementRepository.
const CANCEL_MARKER = "app.assignment_commercial_cancellation";
const REVISION_MARKER = "app.assignment_commercial_revision";
const RESET_MARKER = "app.tenant_reset";

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

// Timestamps are chosen so tests run (2026-08) strictly between the "past" and "future"
// anchors — the END matrix depends on where server-now falls relative to the seeded
// boundaries, and cancellation eligibility on effective_from > now.
const T_2020 = '2020-01-01T00:00:00.000Z';
const T_2022 = '2022-01-01T00:00:00.000Z';
const T_2024 = '2024-01-01T00:00:00.000Z';
const T_2025 = '2025-01-01T00:00:00.000Z';
const T_2030 = '2030-01-01T00:00:00.000Z';
const T_2031 = '2031-01-01T00:00:00.000Z';
const q = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T6-B3 commercial cancellation + END reconciliation (real Postgres 17)',
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
         VALUES ('${o.id}','${o.tenant_id}','${o.placement_process_id}','${randomUUID()}','${randomUUID()}','${randomUUID()}','${T_2020}','BACKFILLED','${state}',${endReason ? `'${endReason}'` : 'NULL'})`,
      );
    }
    async function insertVersion(o: {
      tenant_id: string; contract_assignment_id: string; effective_from: string;
      effective_to?: string | null; cancelled_at?: string | null; cancelled_by?: string | null;
      cancellation_reason_code?: string | null; id?: string;
    }): Promise<string> {
      const id = o.id ?? randomUUID();
      await client.$executeRawUnsafe(
        `INSERT INTO placement."AssignmentRateVersion"
           (id, tenant_id, contract_assignment_id, requisition_id, talent_record_id, pay_rate_amount, bill_rate_amount, currency, rate_period, effective_from, effective_to, recorded_by, cancelled_at, cancelled_by, cancellation_reason_code)
         VALUES ('${id}','${o.tenant_id}','${o.contract_assignment_id}','${randomUUID()}','${randomUUID()}',
           80.00,120.00,'USD','HOURLY','${o.effective_from}',${q(o.effective_to ?? null)},'${randomUUID()}',${q(o.cancelled_at ?? null)},${q(o.cancelled_by ?? null)},${q(o.cancellation_reason_code ?? null)})`,
      );
      return id;
    }
    const rowsFor = (tenant: string, aid: string) =>
      client.assignmentRateVersion.findMany({ where: { tenant_id: tenant, contract_assignment_id: aid }, orderBy: { effective_from: 'asc' } });
    // Run `SET LOCAL <marker>='authorized'` + a body statement inside ONE tx.
    const inTx = (markerSetSql: string, bodySql: string) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(markerSetSql);
        await tx.$executeRawUnsafe(bodySql);
      });
    const setCancel = `SET LOCAL ${CANCEL_MARKER} = 'authorized'`;
    const setRevision = `SET LOCAL ${REVISION_MARKER} = 'authorized'`;
    const setReset = `SET LOCAL ${RESET_MARKER} = 'authorized'`;

    // ===================== §7/§8 trigger truth table =====================
    it('cancellation branch: the exact three-field write succeeds under the cancellation marker', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      const vid = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      const by = randomUUID();
      await inTx(setCancel, `UPDATE placement."AssignmentRateVersion" SET cancelled_at = now(), cancelled_by = '${by}', cancellation_reason_code = 'CLIENT_REQUEST' WHERE id = '${vid}'`);
      const row = await client.assignmentRateVersion.findFirstOrThrow({ where: { id: vid } });
      expect(row.cancelled_at).not.toBeNull();
      expect(row.cancelled_by).toBe(by);
      expect(row.cancellation_reason_code).toBe('CLIENT_REQUEST');
    });

    it('cancellation branch: PARTIAL metadata (only cancelled_at) is rejected', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      const vid = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      await expect(inTx(setCancel, `UPDATE placement."AssignmentRateVersion" SET cancelled_at = now() WHERE id = '${vid}'`)).rejects.toThrow();
    });

    it('cancellation branch: a SECOND cancellation of an already-cancelled row is rejected', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      const vid = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null, cancelled_at: T_2025, cancelled_by: randomUUID(), cancellation_reason_code: 'DATA_CORRECTION' });
      await expect(inTx(setCancel, `UPDATE placement."AssignmentRateVersion" SET cancelled_at = now(), cancelled_by = '${randomUUID()}', cancellation_reason_code = 'CLIENT_REQUEST' WHERE id = '${vid}'`)).rejects.toThrow();
    });

    it('cancellation branch: a money mutation alongside cancellation is rejected', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      const vid = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      await expect(inTx(setCancel, `UPDATE placement."AssignmentRateVersion" SET cancelled_at = now(), cancelled_by = '${randomUUID()}', cancellation_reason_code = 'CLIENT_REQUEST', pay_rate_amount = 999.00 WHERE id = '${vid}'`)).rejects.toThrow();
    });

    it('the cancellation marker CANNOT first-close an open window', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      const vid = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      await expect(inTx(setCancel, `UPDATE placement."AssignmentRateVersion" SET effective_to = '${T_2030}' WHERE id = '${vid}'`)).rejects.toThrow();
    });

    it('the revision marker CANNOT cancel, and CANNOT re-open a future boundary', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      const openId = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      const boundedId = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: T_2031 });
      // revision marker cannot write cancellation metadata
      await expect(inTx(setRevision, `UPDATE placement."AssignmentRateVersion" SET cancelled_at = now(), cancelled_by = '${randomUUID()}', cancellation_reason_code = 'CLIENT_REQUEST' WHERE id = '${openId}'`)).rejects.toThrow();
      // revision marker cannot re-open a bounded window
      await expect(inTx(setRevision, `UPDATE placement."AssignmentRateVersion" SET effective_to = NULL WHERE id = '${boundedId}'`)).rejects.toThrow();
    });

    it('re-open branch: a FUTURE bounded boundary re-opens under the cancellation marker', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      // A single bounded window whose close is still in the future (2030) and no open tail.
      const vid = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2030 });
      await inTx(setCancel, `UPDATE placement."AssignmentRateVersion" SET effective_to = NULL WHERE id = '${vid}'`);
      const row = await client.assignmentRateVersion.findFirstOrThrow({ where: { id: vid } });
      expect(row.effective_to).toBeNull();
    });

    it('re-open branch: a HISTORICAL (past) boundary CANNOT be re-opened', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      // effective_to = 2025 is already in the PAST at test time (2026+) → re-open rejected.
      const vid = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2025 });
      await expect(inTx(setCancel, `UPDATE placement."AssignmentRateVersion" SET effective_to = NULL WHERE id = '${vid}'`)).rejects.toThrow();
    });

    it('tenant-reset DELETE remains independent; the cancellation marker does NOT permit DELETE', async () => {
      const tenant = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: randomUUID(), id: aid });
      const keep = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2022, effective_to: null });
      // cancellation marker cannot DELETE
      await expect(inTx(setCancel, `DELETE FROM placement."AssignmentRateVersion" WHERE id = '${keep}'`)).rejects.toThrow();
      // tenant-reset marker CAN DELETE (escape preserved byte-for-byte)
      await inTx(setReset, `DELETE FROM placement."AssignmentRateVersion" WHERE id = '${keep}'`);
      expect(await client.assignmentRateVersion.findFirst({ where: { id: keep } })).toBeNull();
    });

    // ===================== §3/§4 explicit cancellation =====================
    // Seed a predecessor [past, Y) + a FUTURE open tail [Y, ∞); Y=2030 is future.
    async function seedFutureTail(): Promise<{ tenant: string; ppid: string; aid: string; predId: string; tailId: string }> {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const predId = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2030 });
      const tailId = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: null });
      return { tenant, ppid, aid, predId, tailId };
    }
    const cancel = (s: { tenant: string; ppid: string }, revisionId: string, reason = 'SCHEDULE_WITHDRAWN', by = randomUUID()) =>
      repo.cancelCommercialRevision({ tenant_id: s.tenant, placement_process_id: s.ppid, revision_id: revisionId, cancellation_reason_code: reason, cancelled_by: by }, 'x');

    it('cancels a future open tail, re-opens the predecessor, leaves no gap, emits ONE cancelled event', async () => {
      const s = await seedFutureTail();
      const by = randomUUID();
      const series = await cancel(s, s.tailId, 'SCHEDULE_WITHDRAWN', by);
      // Response = refreshed non-cancelled series: a single OPEN current version.
      expect(series).toHaveLength(1);
      expect(series[0].effective_to).toBeNull();
      // Predecessor re-opened to [2024, ∞); tail cancelled + retained.
      const rows = await rowsFor(s.tenant, s.aid);
      const pred = rows.find((r) => r.id === s.predId)!;
      const tail = rows.find((r) => r.id === s.tailId)!;
      expect(pred.effective_to).toBeNull();
      expect(tail.cancelled_at).not.toBeNull();
      expect(tail.cancelled_by).toBe(by);
      expect(tail.cancellation_reason_code).toBe('SCHEDULE_WITHDRAWN');
      // Exactly one cancellation event, identity-only (no money).
      const evs = await client.outboxEvent.findMany({ where: { tenant_id: s.tenant, event_type: 'placement.assignment.rate_version.cancelled' } });
      expect(evs).toHaveLength(1);
      const payload = evs[0].event_payload as Record<string, unknown>;
      expect(payload['assignment_rate_version_id']).toBe(s.tailId);
      expect(payload['cancellation_reason_code']).toBe('SCHEDULE_WITHDRAWN');
      for (const banned of ['pay_rate_amount', 'bill_rate_amount', 'currency', 'rate_period', 'spread_amount', 'margin_percent', 'markup_percent']) {
        expect(payload).not.toHaveProperty(banned);
      }
    });

    it('refuses cancelling the CURRENT (non-future) version → 409 revision_not_future', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const cur = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      await expect(cancel({ tenant, ppid }, cur)).rejects.toMatchObject({ code: 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', context: { details: { reason: 'revision_not_future' } } });
    });

    it('refuses cancelling a HISTORICAL version → 409 revision_not_future', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const hist = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2022, effective_to: T_2024 });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      await expect(cancel({ tenant, ppid }, hist)).rejects.toMatchObject({ code: 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', context: { details: { reason: 'revision_not_future' } } });
    });

    it('refuses cancelling an INTERIOR future (bounded) version → 409 cancellation_would_create_gap', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2030 });
      const interior = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: T_2031 });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2031, effective_to: null });
      await expect(cancel({ tenant, ppid }, interior)).rejects.toMatchObject({ code: 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', context: { details: { reason: 'cancellation_would_create_gap' } } });
    });

    it('refuses cancelling an ALREADY-cancelled version → 409 already_cancelled', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      const cancelled = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: null, cancelled_at: T_2025, cancelled_by: randomUUID(), cancellation_reason_code: 'CLIENT_REQUEST' });
      await expect(cancel({ tenant, ppid }, cancelled)).rejects.toMatchObject({ code: 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', context: { details: { reason: 'already_cancelled' } } });
    });

    it('refuses cancellation on an ENDED assignment → 404', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid, lifecycle_state: 'ENDED' });
      const tail = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: null });
      await expect(cancel({ tenant, ppid }, tail)).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });

    it('refuses an unknown revision id → 404', async () => {
      const s = await seedFutureTail();
      await expect(cancel(s, randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    });

    it('refuses the reserved ASSIGNMENT_ENDED reason on an explicit cancellation → 400', async () => {
      const s = await seedFutureTail();
      await expect(cancel(s, s.tailId, 'ASSIGNMENT_ENDED')).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    });

    // ===================== §5 same-instant reservation =====================
    it('a cancelled row keeps reserving its exact effective_from — a re-schedule there stays 409 duplicate_effective_from', async () => {
      const s = await seedFutureTail();
      await cancel(s, s.tailId); // predecessor re-opened to [2024, ∞); tail cancelled at 2030
      // Now a new revision AT the cancelled tail's instant (2030) collides on the
      // non-partial unique key even though the tail no longer participates in overlap.
      await expect(
        repo.createCommercialRevision(
          { tenant_id: s.tenant, placement_process_id: s.ppid, pay_rate_amount: '90.00', bill_rate_amount: '150.00', currency: 'USD', rate_period: 'HOURLY', effective_from: T_2030, change_reason: 'reschedule', recorded_by: randomUUID() },
          'x',
        ),
      ).rejects.toMatchObject({ code: 'ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT', context: { details: { reason: 'duplicate_effective_from' } } });
    });

    // ===================== §16/§17 END reconciliation matrix =====================
    const endAssignment = (tenant: string, ppid: string) =>
      repo.endAssignment({ tenant_id: tenant, placement_process_id: ppid, end_reason: 'COMPLETED', ended_by: randomUUID() }, 'x');
    async function endedAt(tenant: string, aid: string): Promise<Date> {
      const ca = await client.contractAssignment.findFirstOrThrow({ where: { id: aid } });
      expect(ca.lifecycle_state).toBe('ENDED');
      expect(ca.ended_at).not.toBeNull();
      return ca.ended_at as Date;
    }
    function assertNothingEffectiveBeyond(rows: Array<{ effective_to: Date | null; cancelled_at: Date | null }>, tEnd: Date): void {
      for (const r of rows) {
        if (r.cancelled_at !== null) continue;
        expect(r.effective_to).not.toBeNull(); // no open tail survives END
        expect(r.effective_to!.getTime()).toBeLessThanOrEqual(tEnd.getTime());
      }
    }

    it('§17 T_end < B: current version closes at T_end; the two future versions are cancelled (ASSIGNMENT_ENDED)', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const v1 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2030 }); // current [2024,2030)
      const v2 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: T_2031 });
      const v3 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2031, effective_to: null });
      await endAssignment(tenant, ppid);
      const tEnd = await endedAt(tenant, aid);
      const rows = await rowsFor(tenant, aid);
      const r1 = rows.find((r) => r.id === v1)!; const r2 = rows.find((r) => r.id === v2)!; const r3 = rows.find((r) => r.id === v3)!;
      expect(r1.cancelled_at).toBeNull();
      expect(r1.effective_to!.getTime()).toBe(tEnd.getTime()); // re-opened then closed at T_end
      expect(r2.cancellation_reason_code).toBe('ASSIGNMENT_ENDED');
      expect(r3.cancellation_reason_code).toBe('ASSIGNMENT_ENDED');
      assertNothingEffectiveBeyond(rows, tEnd);
      // one cancelled event per cancelled future version
      const evs = await client.outboxEvent.findMany({ where: { tenant_id: tenant, event_type: 'placement.assignment.rate_version.cancelled' } });
      expect(evs).toHaveLength(2);
    });

    it('§17 B < T_end < C: interior current closes at T_end; only the future version is cancelled; history untouched', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const v1 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2020, effective_to: T_2024 }); // history
      const v2 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2030 }); // current
      const v3 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: null }); // future
      await endAssignment(tenant, ppid);
      const tEnd = await endedAt(tenant, aid);
      const rows = await rowsFor(tenant, aid);
      const r1 = rows.find((r) => r.id === v1)!; const r2 = rows.find((r) => r.id === v2)!; const r3 = rows.find((r) => r.id === v3)!;
      expect(r1.effective_to!.toISOString()).toBe(new Date(T_2024).toISOString()); // untouched
      expect(r1.cancelled_at).toBeNull();
      expect(r2.cancelled_at).toBeNull();
      expect(r2.effective_to!.getTime()).toBe(tEnd.getTime());
      expect(r3.cancellation_reason_code).toBe('ASSIGNMENT_ENDED');
      assertNothingEffectiveBeyond(rows, tEnd);
    });

    it('§17 T_end > C: the current open tail simply closes at T_end; nothing is cancelled', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const v1 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2020, effective_to: T_2022 });
      const v2 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2022, effective_to: T_2024 });
      const v3 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null }); // current open
      await endAssignment(tenant, ppid);
      const tEnd = await endedAt(tenant, aid);
      const rows = await rowsFor(tenant, aid);
      const r3 = rows.find((r) => r.id === v3)!;
      expect(r3.cancelled_at).toBeNull();
      expect(r3.effective_to!.getTime()).toBe(tEnd.getTime());
      expect(rows.filter((r) => r.cancelled_at !== null)).toHaveLength(0);
      expect(rows.find((r) => r.id === v1)!.effective_to!.toISOString()).toBe(new Date(T_2022).toISOString());
      expect(rows.find((r) => r.id === v2)!.effective_to!.toISOString()).toBe(new Date(T_2024).toISOString());
      assertNothingEffectiveBeyond(rows, tEnd);
      const evs = await client.outboxEvent.findMany({ where: { tenant_id: tenant, event_type: 'placement.assignment.rate_version.cancelled' } });
      expect(evs).toHaveLength(0);
    });

    it('END always leaves the ended assignment with no selectable future commercial version', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2030 });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: null });
      await endAssignment(tenant, ppid);
      // The point-in-time resolver at a far-future instant returns nothing selectable.
      const projected = await repo.findAssignmentCommercialProjection(tenant, ppid, 'x', new Date(T_2031));
      expect(projected).toBeNull();
    });

    // ===================== §29 atomicity (forced rollback) =====================
    it('a reconciliation failure rolls back completely — assignment ACTIVE, no cancellation metadata, no events', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      const v1 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: T_2030 });
      const v2 = await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2030, effective_to: null });
      // Inject a failure: any outbox write inside the END tx throws → the whole
      // reconciliation must roll back (cancellations, boundary edits, state flip).
      const failing = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop === '$transaction') {
            return (fn: (tx: unknown) => unknown, ...rest: unknown[]) =>
              (target.$transaction as (f: (tx: unknown) => unknown, ...r: unknown[]) => unknown)(async (tx: any) => {
                const txProxy = new Proxy(tx, {
                  get(t, p) {
                    if (p === 'outboxEvent') return { create: () => { throw new Error('injected outbox failure'); } };
                    const val = t[p];
                    return typeof val === 'function' ? val.bind(t) : val;
                  },
                });
                return fn(txProxy);
              }, ...rest);
          }
          const val = Reflect.get(target, prop, receiver);
          return typeof val === 'function' ? val.bind(target) : val;
        },
      }) as unknown as PrismaService;
      const failingRepo = new PlacementRepository(failing);
      await expect(
        failingRepo.endAssignment({ tenant_id: tenant, placement_process_id: ppid, end_reason: 'COMPLETED', ended_by: randomUUID() }, 'x'),
      ).rejects.toThrow();
      // Nothing changed.
      const ca = await client.contractAssignment.findFirstOrThrow({ where: { id: aid } });
      expect(ca.lifecycle_state).toBe('ACTIVE');
      expect(ca.ended_at).toBeNull();
      const rows = await rowsFor(tenant, aid);
      expect(rows.every((r) => r.cancelled_at === null)).toBe(true);
      expect(rows.find((r) => r.id === v1)!.effective_to!.toISOString()).toBe(new Date(T_2030).toISOString());
      expect(rows.find((r) => r.id === v2)!.effective_to).toBeNull();
      const evs = await client.outboxEvent.findMany({ where: { tenant_id: tenant } });
      expect(evs).toHaveLength(0);
    });

    // ===================== §19 concurrency races =====================
    it('cancel vs cancel: two concurrent cancellations of the same tail — exactly one succeeds', async () => {
      const s = await seedFutureTail();
      const results = await Promise.allSettled([cancel(s, s.tailId), cancel(s, s.tailId)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const rows = await rowsFor(s.tenant, s.aid);
      expect(rows.filter((r) => r.cancelled_at !== null)).toHaveLength(1);
      expect(rows.find((r) => r.id === s.predId)!.effective_to).toBeNull(); // re-opened once
    });

    it('cancel vs revision: serialize on the assignment lock — no overlap survives', async () => {
      const s = await seedFutureTail();
      await Promise.allSettled([
        cancel(s, s.tailId),
        repo.createCommercialRevision({ tenant_id: s.tenant, placement_process_id: s.ppid, pay_rate_amount: '90.00', bill_rate_amount: '150.00', currency: 'USD', rate_period: 'HOURLY', effective_from: T_2031, change_reason: 'r', recorded_by: randomUUID() }, 'x'),
      ]);
      // Whatever the interleaving, at most one non-cancelled OPEN version remains.
      const rows = await rowsFor(s.tenant, s.aid);
      expect(rows.filter((r) => r.cancelled_at === null && r.effective_to === null).length).toBeLessThanOrEqual(1);
    });

    it('cancel vs END: the assignment ends and no non-cancelled future version survives', async () => {
      const s = await seedFutureTail();
      await Promise.allSettled([cancel(s, s.tailId), endAssignment(s.tenant, s.ppid)]);
      const ca = await client.contractAssignment.findFirstOrThrow({ where: { id: s.aid } });
      if (ca.lifecycle_state === 'ENDED') {
        const rows = await rowsFor(s.tenant, s.aid);
        assertNothingEffectiveBeyond(rows, ca.ended_at as Date);
      }
    });

    it('END vs END: two concurrent ends — the assignment ends exactly once', async () => {
      const tenant = randomUUID(); const ppid = randomUUID(); const aid = randomUUID();
      await insertAssignment({ tenant_id: tenant, placement_process_id: ppid, id: aid });
      await insertVersion({ tenant_id: tenant, contract_assignment_id: aid, effective_from: T_2024, effective_to: null });
      const results = await Promise.allSettled([endAssignment(tenant, ppid), endAssignment(tenant, ppid)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const evs = await client.outboxEvent.findMany({ where: { tenant_id: tenant, event_type: 'placement.assignment.ended' } });
      expect(evs).toHaveLength(1);
    });
  },
);
