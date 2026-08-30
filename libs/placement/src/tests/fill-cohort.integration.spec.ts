import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { PlacementProcessEventRepository } from '../lib/placement-process-event.repository.js';

// Lane 2 / L2-G — the CANONICAL fill read (D-1): fill = PlacementProcess *established*
// (birth PRE_START = created_at), NOT the pipeline `placed` mirror. Proves readFillCohort:
//   - one row per (talent_record_id, requisition_id); first_established_at = MIN created_at;
//   - first_started_at = MIN STARTED-event created_at (null if never started — the
//     Time-to-Fill vs Time-to-Start distinction, D-1);
//   - cohort window [from,to) on the first-established instant (inclusive-from/exclusive-to);
//   - duplicate placements per triple never double-count (collapse to MIN);
//   - requisition_ids (A3 visibility) filter + tenant isolation.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260807120000_placement_fallthrough_reason',
  '20260808120000_placement_replacement_link',
  '20260809120000_placement_contract_assignment',
  '20260825120000_assignment_extension_horizon',
  '20260810100000_placement_assignment_ended_value',
  '20260810110000_placement_assignment_aware_guard',
  '20260810120000_placement_assignment_end_reason',
  '20260810130000_t5_assignment_rate_version',
  '20260812140000_t6_b1_effective_window_substrate',
  '20260813130000_t6_b3_commercial_cancellation',
  '20260814120000_t7_permanent_placement',
  '20260824120000_init_offer_model',
  '20260824130000_placement_offer_id',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

const FROM = new Date('2026-05-01T00:00:00.000Z');
const TO = new Date('2026-06-01T00:00:00.000Z');
const DAY = 86_400_000;
const at = (base: Date, days: number): Date => new Date(base.getTime() + days * DAY);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'L2-G fill cohort — canonical fill = PlacementProcess established (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: PlacementProcessEventRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const t = stmt.trim();
          if (t.length === 0) continue;
          await setup.$executeRawUnsafe(t);
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new PlacementProcessEventRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    // Seed an established PlacementProcess (birth = createdAt) with an optional STARTED
    // event. talent lets multiple placements share a (talent,req) triple.
    async function seedEstablished(args: {
      tenant_id: string;
      requisition_id: string;
      talent_record_id: string;
      createdAt: Date;
      startedAt?: Date;
      id?: string; // control the row id to prove id follows created_at, not MIN(id)
    }): Promise<string> {
      const ppId = args.id ?? randomUUID();
      await prisma.placementProcess.create({
        data: {
          id: ppId,
          tenant_id: args.tenant_id,
          submittal_id: randomUUID(),
          requisition_id: args.requisition_id,
          talent_record_id: args.talent_record_id,
          state: 'PRE_START' as never,
          offered_at: FROM,
          created_at: args.createdAt,
        },
      });
      if (args.startedAt !== undefined) {
        await prisma.placementProcessEvent.create({
          data: {
            id: randomUUID(),
            tenant_id: args.tenant_id,
            placement_process_id: ppId,
            event_type: 'state_transition' as never,
            event_payload: { from: 'READY_TO_START', to: 'STARTED' },
            created_at: args.startedAt,
          },
        });
      }
      return ppId;
    }

    it('D-1: fill = established; started/not-started distinguished (first_started_at null when never STARTED)', async () => {
      const t = randomUUID();
      const req = randomUUID();
      const talentStarted = randomUUID();
      const talentFillOnly = randomUUID();
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: talentStarted, createdAt: at(FROM, 2), startedAt: at(FROM, 9) });
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: talentFillOnly, createdAt: at(FROM, 3) }); // established, never started

      const rows = await repo.readFillCohort({ tenant_id: t, from: FROM, to: TO });
      expect(rows).toHaveLength(2); // both FILL the opening (D-1)
      const started = rows.find((r) => r.talent_record_id === talentStarted)!;
      const fillOnly = rows.find((r) => r.talent_record_id === talentFillOnly)!;
      expect(started.first_established_at.toISOString()).toBe(at(FROM, 2).toISOString());
      expect(started.first_started_at!.toISOString()).toBe(at(FROM, 9).toISOString()); // Time-to-Start applies
      expect(fillOnly.first_established_at.toISOString()).toBe(at(FROM, 3).toISOString());
      expect(fillOnly.first_started_at).toBeNull(); // fills, but NOT started — separate metric
    });

    it('duplicate placements per (talent,req) collapse to the FIRST established instant + its placement id', async () => {
      const t = randomUUID();
      const req = randomUUID();
      const talent = randomUUID();
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: talent, createdAt: at(FROM, 5) });
      const earlier = await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: talent, createdAt: at(FROM, 2) });
      const rows = await repo.readFillCohort({ tenant_id: t, from: FROM, to: TO });
      expect(rows).toHaveLength(1); // one triple
      expect(rows[0]!.first_established_at.toISOString()).toBe(at(FROM, 2).toISOString());
      // DISTINCT ON returns the EARLIEST placement's id (the first-established).
      expect(rows[0]!.first_placement_process_id).toBe(earlier);
    });

    it('first_placement_process_id belongs to the EARLIEST-established row, NOT MIN(id)', async () => {
      const t = randomUUID();
      const req = randomUUID();
      const talent = randomUUID();
      // The earlier-established row is given a LARGE id; the later-established row a SMALL
      // id. If the read independently computed MIN(id) it would return the SMALL id (the
      // later row) — proving the id must come from the SAME row that supplied the MIN
      // created_at (DISTINCT ON established ORDER BY created_at ASC).
      const EARLIEST_LARGE_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
      const LATER_SMALL_ID = '00000000-0000-4000-8000-000000000001';
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: talent, createdAt: at(FROM, 2), id: EARLIEST_LARGE_ID });
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: talent, createdAt: at(FROM, 6), id: LATER_SMALL_ID });
      const rows = await repo.readFillCohort({ tenant_id: t, from: FROM, to: TO });
      expect(rows).toHaveLength(1);
      // The instant is the EARLIEST created_at …
      expect(rows[0]!.first_established_at.toISOString()).toBe(at(FROM, 2).toISOString());
      // … and the id is that SAME (earliest) row's id — NOT the numerically smaller id.
      expect(rows[0]!.first_placement_process_id).toBe(EARLIEST_LARGE_ID);
      expect(rows[0]!.first_placement_process_id).not.toBe(LATER_SMALL_ID);
    });

    it('cohort window [from,to) on first-established: inclusive-from, exclusive-to', async () => {
      const t = randomUUID();
      const req = randomUUID();
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: randomUUID(), createdAt: at(FROM, -1) }); // before → out
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: randomUUID(), createdAt: FROM }); // at from → in
      await seedEstablished({ tenant_id: t, requisition_id: req, talent_record_id: randomUUID(), createdAt: TO }); // at to → out
      const rows = await repo.readFillCohort({ tenant_id: t, from: FROM, to: TO });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.first_established_at.toISOString()).toBe(FROM.toISOString());
    });

    it('A3 requisition_ids filter + tenant isolation', async () => {
      const t = randomUUID();
      const other = randomUUID();
      const reqVisible = randomUUID();
      const reqHidden = randomUUID();
      await seedEstablished({ tenant_id: t, requisition_id: reqVisible, talent_record_id: randomUUID(), createdAt: at(FROM, 1) });
      await seedEstablished({ tenant_id: t, requisition_id: reqHidden, talent_record_id: randomUUID(), createdAt: at(FROM, 1) });
      await seedEstablished({ tenant_id: other, requisition_id: reqVisible, talent_record_id: randomUUID(), createdAt: at(FROM, 1) });

      const scoped = await repo.readFillCohort({ tenant_id: t, from: FROM, to: TO, requisition_ids: [reqVisible] });
      expect(scoped).toHaveLength(1);
      expect(scoped[0]!.requisition_id).toBe(reqVisible);

      const wide = await repo.readFillCohort({ tenant_id: t, from: FROM, to: TO });
      expect(wide).toHaveLength(2); // both req of tenant t, never the other tenant

      const emptyVisible = await repo.readFillCohort({ tenant_id: t, from: FROM, to: TO, requisition_ids: [] });
      expect(emptyVisible).toEqual([]); // explicit empty visible-set → nothing
    });
  },
);

function splitDdl(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let inDollar = false;
  let inLineComment = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (!inDollar && ch === '-' && sql[i + 1] === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (sql.startsWith('$$', i)) {
      inDollar = !inDollar;
      current += '$$';
      i += 1;
      continue;
    }
    if (ch === ';' && !inDollar) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}
