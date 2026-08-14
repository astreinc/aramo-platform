import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { VisibilityContextShape } from '@aramo/common';
import {
  PipelineRepository,
  PipelinePrismaService,
} from '@aramo/pipeline';
import {
  RequisitionRepository,
  RequisitionPrismaService,
} from '@aramo/requisition';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B1 — bearing libs/reporting integration proof (real Postgres 17) for the
// authoritative fill-rate + time-to-fill report. Governed by
// Aramo-T9-B1-Directive-v1_0-LOCKED §16 + the Gate-5 Finalization Amendment.
//
// The unit spec (fill-performance.spec.ts) proves the pure aggregation over
// mocked reads. THIS spec proves the SQL-level guarantees the unit spec cannot:
//   - the [from,to) cohort predicate on Requisition.created_at (D-3);
//   - cohort keyed on created_at, not updated_at (REOPEN never restarts, §7);
//   - MIN(changed_at) de-duplication of multiple `placed` history rows for one
//     (talent, requisition) (§15 — duplicate episode neither double-counts nor
//     advances completion);
//   - multi-opening Nth-distinct completion end-to-end;
//   - `canceled` exclusion from numerator AND denominator (§4);
//   - tenant isolation.
//
// Fill authority is ATS pipeline terminal `placed` read from PipelineStatusHistory
// (D-1) — the rejected capacity path is a `{} as never` stub, so any accidental
// use would throw.

const REQ_MIGRATIONS = [
  '20260602100000_init_requisition_model',
  '20260603140100_add_import_batch_id_to_requisition',
  '20260605123400_add_compensation_fields_to_requisition',
  '20260609120000_search_pr1_pg_trgm_gin',
  '20260611220000_job_module_requisition_fields',
  '20260612120000_drop_legacy_requisition_comp',
  '20260618120000_add_rate_type_subk_runmatch',
  '20260721000000_add_publish_surface',
  '20260731120000_add_requisition_lifecycle_event',
  '20260801120000_add_version_to_requisition',
  '20260802120000_lifecycle_previous_status_nullable',
  '20260802140000_add_onsite_days_to_requisition',
  '20260802160000_add_user_requisition_state',
  '20260802180000_add_requisition_number',
  '20260803120000_recruiting_status_supersession',
  '20260811120000_t4b2_drop_openings_available',
  '20260812130000_t8p1_requisition_external_identity_unique',
].map((d) =>
  resolve(__dirname, `../../../requisition/prisma/migrations/${d}/migration.sql`),
);

const PIPELINE_MIGRATIONS = [
  '20260602150000_init_pipeline_model',
  '20260807100000_e6_pipeline_live_episode_unique',
].map((d) =>
  resolve(__dirname, `../../../pipeline/prisma/migrations/${d}/migration.sql`),
);

// Period under test: [FROM, TO) — one month, half-open, UTC-absolute.
const FROM = new Date('2026-03-01T00:00:00.000Z');
const TO = new Date('2026-04-01T00:00:00.000Z');
const DAY_MS = 86_400_000;
const at = (base: Date, days: number): Date =>
  new Date(base.getTime() + days * DAY_MS);

const seeAll = {
  see_all_requisition: true,
} as unknown as VisibilityContextShape;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')(
  'T9-B1 fill-performance (real Postgres 17)',
  () => {
    let container: StartedPostgreSqlContainer;
    let reqPrisma: RequisitionPrismaService;
    let pipePrisma: PipelinePrismaService;
    let svc: ReportingService;
    let reqNo = 1;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new RequisitionPrismaService(url);
      await setup.$connect();
      for (const path of [...REQ_MIGRATIONS, ...PIPELINE_MIGRATIONS]) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      reqPrisma = new RequisitionPrismaService(url);
      pipePrisma = new PipelinePrismaService(url);
      await reqPrisma.$connect();
      await pipePrisma.$connect();

      // listCohortForActor uses ONLY this.prisma; the policy/capacity deps are
      // never touched, so they are `{} as never` stubs (ctor-satisfying only).
      const requisitionRepository = new RequisitionRepository(
        reqPrisma,
        {} as never, // setPriorityPolicy
        {} as never, // transitionPolicy
        {} as never, // capacity — the rejected path; must never be called
      );
      const pipelineRepository = new PipelineRepository(pipePrisma);

      svc = new ReportingService(
        {} as never, // company
        {} as never, // contact
        {} as never, // talentRecord
        {} as never, // savedList
        {} as never, // calendar
        {} as never, // activity
        requisitionRepository,
        pipelineRepository,
        {} as never, // tenantSetting
        {} as never, // capacity
        {} as never, // placementEventRepository (T9-B2; unused by fill-performance)
      );
    }, 180_000);

    afterAll(async () => {
      await reqPrisma?.$disconnect();
      await pipePrisma?.$disconnect();
      await container?.stop();
    });

    async function seedReq(args: {
      tenant_id: string;
      openings: number;
      status: string;
      created_at: Date;
      updated_at?: Date;
      site_id?: string;
    }): Promise<string> {
      const id = randomUUID();
      await reqPrisma.requisition.create({
        data: {
          id,
          tenant_id: args.tenant_id,
          title: `req-${reqNo}`,
          requisition_number: reqNo++,
          company_id: randomUUID(),
          openings: args.openings,
          status: args.status as never,
          created_at: args.created_at,
          ...(args.updated_at === undefined
            ? {}
            : { updated_at: args.updated_at }),
          ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        },
      });
      return id;
    }

    // Seed a `placed` outcome: a pipeline row + a PipelineStatusHistory row that
    // transitioned INTO `placed` at `changedAt`. The reporting read derives the
    // fill authority from the HISTORY row (status_to='placed'), joined to the
    // pipeline for talent/req.
    async function seedPlaced(args: {
      tenant_id: string;
      requisition_id: string;
      talent_record_id: string;
      changedAt: Date;
    }): Promise<void> {
      const pipeline_id = randomUUID();
      await pipePrisma.pipeline.create({
        data: {
          id: pipeline_id,
          tenant_id: args.tenant_id,
          talent_record_id: args.talent_record_id,
          requisition_id: args.requisition_id,
          status: 'placed' as never,
        },
      });
      await pipePrisma.pipelineStatusHistory.create({
        data: {
          id: randomUUID(),
          tenant_id: args.tenant_id,
          pipeline_id,
          status_from: 'offered' as never,
          status_to: 'placed' as never,
          changed_at: args.changedAt,
        },
      });
    }

    it('cohorts by created_at ∈ [from,to): boundary inclusive-from, exclusive-to', async () => {
      const tenant = randomUUID();
      // before window (excluded), exactly at FROM (included), exactly at TO
      // (excluded — half-open), inside (included).
      await seedReq({ tenant_id: tenant, openings: 1, status: 'open', created_at: at(FROM, -1) });
      await seedReq({ tenant_id: tenant, openings: 1, status: 'open', created_at: FROM });
      await seedReq({ tenant_id: tenant, openings: 1, status: 'open', created_at: TO });
      await seedReq({ tenant_id: tenant, openings: 2, status: 'open', created_at: at(FROM, 10) });

      const v = await svc.getFillPerformance(
        { tenant_id: tenant, user_id: 'u', scopes: ['report:read'], visibility: seeAll },
        { from: FROM, to: TO },
      );
      // Only the FROM req (1) + the inside req (2) are in cohort → openings 3.
      expect(v.openings).toBe(3);
      expect(v.fill_rate).toBe(0); // nothing placed
    });

    it('cohort keyed on created_at, not updated_at (REOPEN never restarts the clock)', async () => {
      const tenant = randomUUID();
      // created inside the window, but updated_at AFTER `to` (a later REOPEN-style
      // touch). It must still be in the cohort and its TTF start must be created_at.
      const req = await seedReq({
        tenant_id: tenant,
        openings: 1,
        status: 'open',
        created_at: at(FROM, 2),
        updated_at: at(TO, 30),
      });
      await seedPlaced({
        tenant_id: tenant,
        requisition_id: req,
        talent_record_id: randomUUID(),
        changedAt: at(FROM, 7),
      });
      const v = await svc.getFillPerformance(
        { tenant_id: tenant, user_id: 'u', scopes: ['report:read'], visibility: seeAll },
        { from: FROM, to: TO },
      );
      expect(v.openings).toBe(1);
      expect(v.fully_filled_requisitions).toBe(1);
      expect(v.time_to_fill.count).toBe(1);
      // start=created_at(FROM+2), completion=placed(FROM+7) → 5 days (NOT from updated_at).
      expect(v.time_to_fill.average_days).toBe(5);
    });

    it('duplicate placed episodes for one (talent,req) count once and use the FIRST instant', async () => {
      const tenant = randomUUID();
      const talent = randomUUID();
      const req = await seedReq({ tenant_id: tenant, openings: 1, status: 'open', created_at: FROM });
      // Same talent placed TWICE (two history rows) — MIN picks the earlier.
      await seedPlaced({ tenant_id: tenant, requisition_id: req, talent_record_id: talent, changedAt: at(FROM, 9) });
      await seedPlaced({ tenant_id: tenant, requisition_id: req, talent_record_id: talent, changedAt: at(FROM, 3) });

      const v = await svc.getFillPerformance(
        { tenant_id: tenant, user_id: 'u', scopes: ['report:read'], visibility: seeAll },
        { from: FROM, to: TO },
      );
      expect(v.openings).toBe(1);
      expect(v.filled_openings).toBe(1); // one distinct talent, not two
      expect(v.fill_rate).toBe(100);
      expect(v.time_to_fill.count).toBe(1);
      expect(v.time_to_fill.average_days).toBe(3); // FIRST placed instant, not 9
    });

    it('multi-opening: completion is the Nth (last-required) distinct placed instant', async () => {
      const tenant = randomUUID();
      const req = await seedReq({ tenant_id: tenant, openings: 2, status: 'open', created_at: FROM });
      // Two distinct talents; opening filled at day 4 then day 8 → completion day 8.
      await seedPlaced({ tenant_id: tenant, requisition_id: req, talent_record_id: randomUUID(), changedAt: at(FROM, 8) });
      await seedPlaced({ tenant_id: tenant, requisition_id: req, talent_record_id: randomUUID(), changedAt: at(FROM, 4) });

      const v = await svc.getFillPerformance(
        { tenant_id: tenant, user_id: 'u', scopes: ['report:read'], visibility: seeAll },
        { from: FROM, to: TO },
      );
      expect(v.filled_openings).toBe(2);
      expect(v.fully_filled_requisitions).toBe(1);
      expect(v.time_to_fill.count).toBe(1);
      expect(v.time_to_fill.average_days).toBe(8); // 2nd distinct (last required)
    });

    it('canceled requisition is excluded from numerator AND denominator', async () => {
      const tenant = randomUUID();
      const canceled = await seedReq({ tenant_id: tenant, openings: 5, status: 'canceled', created_at: FROM });
      await seedPlaced({ tenant_id: tenant, requisition_id: canceled, talent_record_id: randomUUID(), changedAt: at(FROM, 2) });
      const open = await seedReq({ tenant_id: tenant, openings: 1, status: 'open', created_at: at(FROM, 1) });
      await seedPlaced({ tenant_id: tenant, requisition_id: open, talent_record_id: randomUUID(), changedAt: at(FROM, 3) });

      const v = await svc.getFillPerformance(
        { tenant_id: tenant, user_id: 'u', scopes: ['report:read'], visibility: seeAll },
        { from: FROM, to: TO },
      );
      expect(v.openings).toBe(1); // the canceled req's 5 openings are excluded
      expect(v.filled_openings).toBe(1);
      expect(v.fill_rate).toBe(100);
    });

    it('tenant isolation: a tenant report never sees another tenant’s reqs or placements', async () => {
      const tenantA = randomUUID();
      const tenantB = randomUUID();
      const reqA = await seedReq({ tenant_id: tenantA, openings: 1, status: 'open', created_at: FROM });
      await seedPlaced({ tenant_id: tenantA, requisition_id: reqA, talent_record_id: randomUUID(), changedAt: at(FROM, 2) });
      const reqB = await seedReq({ tenant_id: tenantB, openings: 3, status: 'open', created_at: FROM });
      await seedPlaced({ tenant_id: tenantB, requisition_id: reqB, talent_record_id: randomUUID(), changedAt: at(FROM, 2) });

      const v = await svc.getFillPerformance(
        { tenant_id: tenantA, user_id: 'u', scopes: ['report:read'], visibility: seeAll },
        { from: FROM, to: TO },
      );
      expect(v.openings).toBe(1); // only tenant A's req
      expect(v.fill_rate).toBe(100);
    });
  },
);

// DDL splitter — statement boundaries on `;`, honoring `$$`-quoted bodies AND
// skipping `--` line comments (older requisition migrations carry `-- …;`
// comment lines; a comment-blind splitter would truncate a statement there).
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
