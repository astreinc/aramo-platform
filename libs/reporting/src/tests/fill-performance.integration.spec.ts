import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import type { VisibilityContextShape } from '@aramo/common';
import { PipelinePrismaService } from '@aramo/pipeline';
import {
  RequisitionRepository,
  RequisitionPrismaService,
} from '@aramo/requisition';
import {
  PlacementProcessEventRepository,
  PrismaService as PlacementPrismaService,
} from '@aramo/placement';

import { ReportingService } from '../lib/reporting.service.js';

// T9-B1 — bearing libs/reporting integration proof (real Postgres 17) for the
// authoritative fill-rate + time-to-fill report. Governed by
// Aramo-T9-B1-Directive-v1_0-LOCKED §16 + the Gate-5 Finalization Amendment.
//
// The unit spec (fill-performance.spec.ts) proves the pure aggregation over
// mocked reads. THIS spec proves the SQL-level guarantees the unit spec cannot:
//   - the [from,to) cohort predicate on Requisition.created_at (D-3);
//   - cohort keyed on created_at, not updated_at (REOPEN never restarts, §7);
//   - MIN(created_at) de-duplication of multiple PlacementProcess rows for one
//     (talent, requisition) (§15 — a duplicate placement neither double-counts nor
//     advances completion);
//   - multi-opening Nth-distinct completion end-to-end;
//   - `canceled` exclusion from numerator AND denominator (§4);
//   - tenant isolation.
//
// Lane 2 / L2-G — fill authority is now PlacementProcess *established* (birth PRE_START,
// created_at = fill instant), read via readFillCohort (D-1). The rejected capacity path
// AND the retired pipeline `placed` read are both `{} as never` stubs, so any accidental
// use throws — the authority flip is proven, not assumed.

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
  // L1-F1 — RequisitionLifecycleEvent append-only triggers + reset escape.
  '20260827120000_requisition_lifecycle_event_append_only',
].map((d) =>
  resolve(__dirname, `../../../requisition/prisma/migrations/${d}/migration.sql`),
);

const PIPELINE_MIGRATIONS = [
  '20260602150000_init_pipeline_model',
  '20260807100000_e6_pipeline_live_episode_unique',
  '20260827120000_l2a_pipeline_version_column',
  // L2-B — append-only history trigger; nullable status_from + ended_at/ended_by_id; pipeline OutboxEvent.
  '20260828100000_l2b_pipeline_history_append_only',
  '20260828110000_l2b_pipeline_ended_at_nullable_status_from',
  '20260828120000_l2b_pipeline_outbox_event',
  '20260828130000_l2c_pipeline_qualified_completed_enum',
  '20260828140000_l2c_pipeline_live_episode_recreate',
  '20260828150000_l2c_pipeline_disposition',
  '20260828160000_l2d_pipeline_entry_provenance',
].map((d) =>
  resolve(__dirname, `../../../pipeline/prisma/migrations/${d}/migration.sql`),
);

// Lane 2 / L2-G — canonical fill authority = PlacementProcess established; this spec now
// seeds the PlacementProcess spine (not pipeline `placed` history). Placement schema.
const PLACEMENT_MIGRATIONS = [
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
].map((d) =>
  resolve(__dirname, `../../../placement/prisma/migrations/${d}/migration.sql`),
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
    let placePrisma: PlacementPrismaService;
    let svc: ReportingService;
    let reqNo = 1;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17').start();
      const url = container.getConnectionUri();

      const setup = new RequisitionPrismaService(url);
      await setup.$connect();
      for (const path of [
        ...REQ_MIGRATIONS,
        ...PIPELINE_MIGRATIONS,
        ...PLACEMENT_MIGRATIONS,
      ]) {
        for (const stmt of splitDdl(readFileSync(path, 'utf8'))) {
          const trimmed = stmt.trim();
          if (trimmed.length === 0) continue;
          await setup.$executeRawUnsafe(trimmed);
        }
      }
      await setup.$disconnect();

      reqPrisma = new RequisitionPrismaService(url);
      pipePrisma = new PipelinePrismaService(url);
      placePrisma = new PlacementPrismaService(url);
      await reqPrisma.$connect();
      await pipePrisma.$connect();
      await placePrisma.$connect();

      // listCohortForActor uses ONLY this.prisma; the policy/capacity deps are
      // never touched, so they are `{} as never` stubs (ctor-satisfying only).
      const requisitionRepository = new RequisitionRepository(
        reqPrisma,
        {} as never, // setPriorityPolicy
        {} as never, // transitionPolicy
        {} as never, // capacity — the rejected path; must never be called
        { deriveByRequisitionIds: async () => new Map() } as never,
      );
      const placementEventRepository = new PlacementProcessEventRepository(
        placePrisma,
      );

      svc = new ReportingService(
        {} as never, // company
        {} as never, // contact
        {} as never, // talentRecord
        {} as never, // savedList
        {} as never, // calendar
        {} as never, // activity
        requisitionRepository,
        // L2-G — fill authority is the placement spine; getFillPerformance must NOT read
        // pipeline. Stubbed so any accidental legacy `placed` read throws (authority-flip
        // proof — the legacy read survives ONLY in the diagnostic comparator).
        {} as never, // pipelineRepository
        {} as never, // tenantSetting
        {} as never, // capacity
        placementEventRepository, // L2-G: the canonical fill read (readFillCohort)
        {} as never, // placementPipelineRepository (T9-B3; unused here)
        {} as never, // T7-P4 guaranteeExposureRepository (unused here)
        {} as never, // commercialMarginRepository (T9-B4; unused here)
        { findFirstSubmittedByGrain: async () => [] } as never, // L2-E submitted-history port
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

    // Lane 2 / L2-G — the fill FACT is now a PlacementProcess *established* (birth
    // PRE_START), whose `created_at` is the canonical fill instant. The reporting read
    // derives fill from readFillCohort (first-established per (talent, req)), NOT the
    // retired pipeline `placed` history. `establishedAt` is the controlled fill instant;
    // the assertions (cohort boundary, REOPEN, MIN dedup, Nth-fill, canceled, isolation)
    // are UNCHANGED — only the fact source moved.
    async function seedEstablished(args: {
      tenant_id: string;
      requisition_id: string;
      talent_record_id: string;
      establishedAt: Date;
    }): Promise<void> {
      await placePrisma.placementProcess.create({
        data: {
          id: randomUUID(),
          tenant_id: args.tenant_id,
          submittal_id: randomUUID(),
          talent_record_id: args.talent_record_id,
          requisition_id: args.requisition_id,
          state: 'PRE_START' as never,
          offered_at: args.establishedAt,
          created_at: args.establishedAt,
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
      await seedEstablished({
        tenant_id: tenant,
        requisition_id: req,
        talent_record_id: randomUUID(),
        establishedAt: at(FROM, 7),
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
      await seedEstablished({ tenant_id: tenant, requisition_id: req, talent_record_id: talent, establishedAt: at(FROM, 9) });
      await seedEstablished({ tenant_id: tenant, requisition_id: req, talent_record_id: talent, establishedAt: at(FROM, 3) });

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
      await seedEstablished({ tenant_id: tenant, requisition_id: req, talent_record_id: randomUUID(), establishedAt: at(FROM, 8) });
      await seedEstablished({ tenant_id: tenant, requisition_id: req, talent_record_id: randomUUID(), establishedAt: at(FROM, 4) });

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
      await seedEstablished({ tenant_id: tenant, requisition_id: canceled, talent_record_id: randomUUID(), establishedAt: at(FROM, 2) });
      const open = await seedReq({ tenant_id: tenant, openings: 1, status: 'open', created_at: at(FROM, 1) });
      await seedEstablished({ tenant_id: tenant, requisition_id: open, talent_record_id: randomUUID(), establishedAt: at(FROM, 3) });

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
      await seedEstablished({ tenant_id: tenantA, requisition_id: reqA, talent_record_id: randomUUID(), establishedAt: at(FROM, 2) });
      const reqB = await seedReq({ tenant_id: tenantB, openings: 3, status: 'open', created_at: FROM });
      await seedEstablished({ tenant_id: tenantB, requisition_id: reqB, talent_record_id: randomUUID(), establishedAt: at(FROM, 2) });

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
