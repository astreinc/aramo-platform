import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { VisibilityContextShape } from '@aramo/common';
import { PrismaService, AssignmentPipelineReadRepository } from '@aramo/placement';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B3 — bearing libs/reporting integration: ReportingService.getAssignmentPipeline
// FOLD over the REAL placement snapshot read. The aggregate SQL is exhaustively
// proven in libs/placement's assignment-pipeline.integration.spec; here we tie the
// service fold (zero-fill order, total_live, coverage/UTC labels, boundedness) to
// real placement data end to end. see-all actor → requisitionRepository unused.

const MIGRATIONS = [
  '20260803180000_init_placement_model',
  '20260805120000_placement_offer_and_outbox',
  '20260806090000_placement_tenant_reset_escape',
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
  // T7-PX — the assignment-pipeline read now excludes conversion targets via the
  // PermanentPlacementConversionLineage table, so this curated set needs the migration.
  '20260817120000_t7_px_contract_to_permanent_conversion',
].map((d) =>
  resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`),
);

const NOW = new Date('2026-06-15T12:00:00.000Z');

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T9-B3 reporting assignment-pipeline fold (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let prisma: PrismaService;
    let svc: ReportingService;

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
      const repo = new AssignmentPipelineReadRepository(prisma);
      svc = new ReportingService(
        {} as never, {} as never, {} as never, {} as never, {} as never,
        {} as never, {} as never, {} as never, {} as never, {} as never,
        {} as never, // placementEventRepository
        repo,
        {} as never, // T7-P4 guaranteeExposureRepository (unused here)
        {} as never, // commercialMarginRepository (T9-B4; unused here)
      );
    }, 180_000);

    afterAll(async () => {
      await prisma?.$disconnect();
      await container?.stop();
    });

    async function pp(tenant: string, req: string, state: string): Promise<string> {
      const id = randomUUID();
      await prisma.placementProcess.create({
        data: { id, tenant_id: tenant, submittal_id: randomUUID(), requisition_id: req, talent_record_id: randomUUID(), state: state as never, offered_at: NOW },
      });
      return id;
    }
    async function ca(tenant: string, req: string, ppId: string, s: 'ACTIVE' | 'ENDED'): Promise<void> {
      await prisma.contractAssignment.create({
        data: { id: randomUUID(), tenant_id: tenant, placement_process_id: ppId, submittal_id: randomUUID(), requisition_id: req, talent_record_id: randomUUID(), started_at: NOW, provenance: 'FORWARD' as never, company_id: randomUUID(), lifecycle_state: s as never, ...(s === 'ENDED' ? { end_reason: 'COMPLETED' as never, ended_at: NOW } : {}) },
      });
    }

    it('folds real placement data: ordered zero-filled by_state, total_live sum, bounded coverage', async () => {
      const t = randomUUID();
      const req = randomUUID();
      await pp(t, req, 'OFFER_ACCEPTED');
      await pp(t, req, 'READY_TO_START');
      // three STARTED: none / ACTIVE / ENDED (boundedness end-to-end)
      await pp(t, req, 'STARTED');
      const s2 = await pp(t, req, 'STARTED');
      await ca(t, req, s2, 'ACTIVE');
      const s3 = await pp(t, req, 'STARTED');
      await ca(t, req, s3, 'ENDED');
      // excluded states must not leak in
      await pp(t, req, 'OFFER_EXTENDED');
      await pp(t, req, 'FELL_THROUGH');

      const actor = {
        tenant_id: t,
        user_id: 'u',
        scopes: ['report:read'],
        visibility: { see_all_requisition: true } as unknown as VisibilityContextShape,
      };
      const v = await svc.getAssignmentPipeline(actor, { now: NOW });

      expect(v.by_state.map((r) => r.state)).toEqual([
        'OFFER_ACCEPTED', 'PRE_START', 'BLOCKED', 'READY_TO_START', 'STARTED',
      ]);
      const bs = Object.fromEntries(v.by_state.map((r) => [r.state, r.count]));
      expect(bs['OFFER_ACCEPTED']).toBe(1);
      expect(bs['PRE_START']).toBe(0);
      expect(bs['READY_TO_START']).toBe(1);
      expect(bs['STARTED']).toBe(3);
      expect(v.total_live).toBe(5); // 1+0+0+1+3 — excludes OFFER_EXTENDED/FELL_THROUGH
      // boundedness: STARTED(3) != active(1)+ended(1)
      expect(v.contract_assignments).toEqual({ active: 1, ended: 1, coverage: 'forward_materialized' });
      expect(v.start_date.timezone_basis).toBe('UTC');
      // no commercial/reason_detail keys anywhere in the response
      const json = JSON.stringify(v);
      for (const banned of ['pay_rate', 'bill_rate', 'margin', 'currency', 'reason_detail', 'ended_at']) {
        expect(json).not.toContain(banned);
      }
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
