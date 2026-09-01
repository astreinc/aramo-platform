import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { PrismaService } from '../lib/prisma/prisma.service.js';
import { AssignmentPipelineReadRepository } from '../lib/assignment-pipeline-read.repository.js';

// T9-B3 — assignment-pipeline current-state snapshot aggregate (real Postgres 17).
// Governed by Aramo-T9-B3-Directive-v1_0-LOCKED. Proves:
//   §3 four live states counted; terminal losses excluded (L4-0: OFFER_* collapsed out);
//   §16 boundedness fixture — STARTED=3, ACTIVE=1, ENDED=1 (STARTED != ACTIVE+ENDED);
//   §8 UTC start-date buckets over the 3 pre-start states (STARTED excluded; null→unspecified);
//   §12 tenant + A3 requisition-id scoping.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260806090000_placement_tenant_reset_escape',
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
  '20260815120000_t7_p2_falloff_remedy',
  // T7-PX — the assignment-pipeline read now excludes conversion targets via the
  // PermanentPlacementConversionLineage table, so this curated set needs the migration.
  '20260817120000_t7_px_contract_to_permanent_conversion',
  '20260824120000_init_offer_model',
  '20260824130000_placement_offer_id',
  '20260901120000_l4_placement_offer_state_collapse',
].map((d) => resolve(__dirname, `../../prisma/migrations/${d}/migration.sql`));

// Fixed snapshot clock so UTC start-date bucketing is deterministic.
const NOW = new Date('2026-06-15T12:00:00.000Z'); // today (UTC) = 2026-06-15
const date = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T9-B3 assignment-pipeline snapshot (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let repo: AssignmentPipelineReadRepository;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();
      const setup = new PrismaService(url);
      await setup.$connect();
      for (const path of MIGRATIONS) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();
      prisma = new PrismaService(url);
      await prisma.$connect();
      repo = new AssignmentPipelineReadRepository(prisma);
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function seedPP(args: {
      tenant_id: string;
      requisition_id: string;
      state: string;
      proposed_start_date?: Date | null;
    }): Promise<string> {
      const id = randomUUID();
      await prisma.placementProcess.create({
        data: {
          id,
          tenant_id: args.tenant_id,
          submittal_id: randomUUID(),
          requisition_id: args.requisition_id,
          talent_record_id: randomUUID(),
          state: args.state as never,
          offered_at: NOW,
          ...(args.proposed_start_date === undefined
            ? {}
            : { proposed_start_date: args.proposed_start_date }),
        },
      });
      return id;
    }

    async function seedCA(args: {
      tenant_id: string;
      requisition_id: string;
      placement_process_id: string;
      lifecycle_state: 'ACTIVE' | 'ENDED';
    }): Promise<void> {
      await prisma.contractAssignment.create({
        data: {
          id: randomUUID(),
          tenant_id: args.tenant_id,
          placement_process_id: args.placement_process_id,
          submittal_id: randomUUID(),
          requisition_id: args.requisition_id,
          talent_record_id: randomUUID(),
          started_at: NOW,
          provenance: 'FORWARD' as never,
          company_id: randomUUID(), // FORWARD rows require a company (CHECK)
          lifecycle_state: args.lifecycle_state as never,
          ...(args.lifecycle_state === 'ENDED'
            ? { end_reason: 'COMPLETED' as never, ended_at: NOW }
            : {}),
        },
      });
    }

    const byState = (rows: Array<{ state: string; count: number }>) =>
      Object.fromEntries(rows.map((r) => [r.state, r.count]));

    it('counts the four live states; excludes the terminal losses', async () => {
      const t = randomUUID();
      const req = randomUUID();
      for (const s of [
        'PRE_START',
        'BLOCKED',
        'READY_TO_START',
        'STARTED',
        'NO_SHOW', // excluded
        'FELL_THROUGH', // excluded
      ]) {
        await seedPP({ tenant_id: t, requisition_id: req, state: s });
      }
      const r = await repo.readAssignmentPipelineSnapshot({ tenant_id: t, now: NOW });
      const bs = byState(r.by_state);
      expect(bs['PRE_START']).toBe(1);
      expect(bs['BLOCKED']).toBe(1);
      expect(bs['READY_TO_START']).toBe(1);
      expect(bs['STARTED']).toBe(1);
      expect(bs['NO_SHOW']).toBeUndefined();
      expect(bs['FELL_THROUGH']).toBeUndefined();
    });

    it('§16 boundedness: STARTED=3 but active=1, ended=1 (STARTED != ACTIVE+ENDED)', async () => {
      const t = randomUUID();
      const req = randomUUID();
      // (1) STARTED with NO ContractAssignment (legacy shape)
      await seedPP({ tenant_id: t, requisition_id: req, state: 'STARTED' });
      // (2) STARTED with ACTIVE
      const p2 = await seedPP({ tenant_id: t, requisition_id: req, state: 'STARTED' });
      await seedCA({ tenant_id: t, requisition_id: req, placement_process_id: p2, lifecycle_state: 'ACTIVE' });
      // (3) STARTED with ENDED
      const p3 = await seedPP({ tenant_id: t, requisition_id: req, state: 'STARTED' });
      await seedCA({ tenant_id: t, requisition_id: req, placement_process_id: p3, lifecycle_state: 'ENDED' });

      const r = await repo.readAssignmentPipelineSnapshot({ tenant_id: t, now: NOW });
      expect(byState(r.by_state)['STARTED']).toBe(3);
      expect(r.contract_assignments.active).toBe(1);
      expect(r.contract_assignments.ended).toBe(1);
    });

    it('UTC start-date buckets over the 3 pre-start states; STARTED excluded; null→unspecified', async () => {
      const t = randomUUID();
      const req = randomUUID();
      await seedPP({ tenant_id: t, requisition_id: req, state: 'PRE_START', proposed_start_date: date('2026-06-14') }); // overdue
      await seedPP({ tenant_id: t, requisition_id: req, state: 'PRE_START', proposed_start_date: date('2026-06-15') }); // today
      await seedPP({ tenant_id: t, requisition_id: req, state: 'BLOCKED', proposed_start_date: date('2026-06-18') }); // next_7 (<= +7=06-22)
      await seedPP({ tenant_id: t, requisition_id: req, state: 'READY_TO_START', proposed_start_date: date('2026-06-25') }); // later (> 06-22)
      await seedPP({ tenant_id: t, requisition_id: req, state: 'BLOCKED', proposed_start_date: null }); // unspecified
      // STARTED with a proposed date must NOT appear in any start-date bucket
      await seedPP({ tenant_id: t, requisition_id: req, state: 'STARTED', proposed_start_date: date('2026-06-14') });

      const r = await repo.readAssignmentPipelineSnapshot({ tenant_id: t, now: NOW });
      expect(r.start_date).toEqual({
        overdue: 1,
        today: 1,
        next_7_days: 1,
        later: 1,
        unspecified: 1,
      });
    });

    it('scopes by tenant and A3 visible requisition ids', async () => {
      const t = randomUUID();
      const other = randomUUID();
      const reqVisible = randomUUID();
      const reqHidden = randomUUID();
      await seedPP({ tenant_id: t, requisition_id: reqVisible, state: 'STARTED' });
      await seedPP({ tenant_id: t, requisition_id: reqHidden, state: 'STARTED' });
      await seedPP({ tenant_id: other, requisition_id: reqVisible, state: 'STARTED' });

      const scoped = await repo.readAssignmentPipelineSnapshot({ tenant_id: t, requisition_ids: [reqVisible], now: NOW });
      expect(byState(scoped.by_state)['STARTED']).toBe(1);
      const wide = await repo.readAssignmentPipelineSnapshot({ tenant_id: t, now: NOW });
      expect(byState(wide.by_state)['STARTED']).toBe(2); // both of tenant t, not other
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
