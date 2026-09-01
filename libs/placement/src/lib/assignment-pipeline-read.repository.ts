import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

export interface AssignmentPipelineSnapshot {
  by_state: Array<{ state: string; count: number }>;
  start_date: {
    overdue: number;
    today: number;
    next_7_days: number;
    later: number;
    unspecified: number;
  };
  contract_assignments: { active: number; ended: number };
}

// The four live assignment-pipeline states (directive §3). The two terminal-loss
// states (NO_SHOW, FELL_THROUGH) are deliberately EXCLUDED. L4-0: OFFER_ACCEPTED
// was collapsed out — a PlacementProcess is now born at PRE_START (downstream of
// an accepted Offer aggregate), so the pipeline begins at PRE_START.
const LIVE_STATES = [
  'PRE_START',
  'BLOCKED',
  'READY_TO_START',
  'STARTED',
] as const;
// Start-date buckets apply only to the pre-start subset (STARTED excluded, §8).
const PRE_START_STATES = [
  'PRE_START',
  'BLOCKED',
  'READY_TO_START',
] as const;

// UTC calendar date (YYYY-MM-DD) for `now`, and now + n days — no tenant
// timezone exists so all date-bucket math is absolute/UTC (directive §8).
function utcDate(now: Date, plusDays = 0): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + plusDays),
  )
    .toISOString()
    .slice(0, 10);
}

// T9-B3 — placement-owned CURRENT-STATE snapshot aggregate for the reporting
// assignment-pipeline view. Governed by Aramo-T9-B3-Directive-v1_0-LOCKED (§14).
// Distinct from PlacementProcessEventRepository.readFallthroughCohort (event-log
// / date-bounded flow); this reads the current `PlacementProcess.state` +
// `proposed_start_date` + bounded `ContractAssignment.lifecycle_state`. Three
// DB-side aggregates, tenant + A3-visible-requisition scoped, no N+1, no fold cap,
// no history scan, no commercial read. Zero-filling + total_live + the coverage /
// timezone labels are the reporting service's fold.
@Injectable()
export class AssignmentPipelineReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async readAssignmentPipelineSnapshot(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
    now: Date;
  }): Promise<AssignmentPipelineSnapshot> {
    const empty: AssignmentPipelineSnapshot = {
      by_state: [],
      start_date: { overdue: 0, today: 0, next_7_days: 0, later: 0, unspecified: 0 },
      contract_assignments: { active: 0, ended: 0 },
    };
    const hasReq = args.requisition_ids !== undefined;
    // An explicit empty visible-set means the actor sees no requisitions.
    if (hasReq && args.requisition_ids!.length === 0) return empty;

    const today = utcDate(args.now);
    const to7 = utcDate(args.now, 7);
    const live = [...LIVE_STATES];
    const preStart = [...PRE_START_STATES];

    // --- by_state (five live states) ---
    const byStateParams: unknown[] = hasReq
      ? [args.tenant_id, live, [...args.requisition_ids!]]
      : [args.tenant_id, live];
    const byStateRows = await this.prisma.$queryRawUnsafe<
      Array<{ state: string; count: bigint }>
    >(
      // Track 7 / T7-PX §13 — a conversion mints a NEW permanent PlacementProcess (STARTED)
      // for the same engagement as the frozen source contract placement (also STARTED). To
      // avoid a DUPLICATE assignment-pipeline count, the conversion TARGET is excluded here
      // (keyed on the conversion lineage — surgical; direct-permanent placements, which are
      // not conversion targets, are unaffected). The source contract placement remains
      // counted once.
      `SELECT state::text AS state, count(*)::bigint AS count
         FROM "placement"."PlacementProcess"
        WHERE tenant_id = $1::uuid
          AND state::text = ANY($2::text[])
          AND id NOT IN (
            SELECT target_placement_process_id
              FROM "placement"."PermanentPlacementConversionLineage"
             WHERE tenant_id = $1::uuid
          )
          ${hasReq ? 'AND requisition_id = ANY($3::uuid[])' : ''}
        GROUP BY state`,
      ...byStateParams,
    );

    // --- start-date buckets (pre-start states only) ---
    const bucketParams: unknown[] = hasReq
      ? [args.tenant_id, preStart, today, to7, [...args.requisition_ids!]]
      : [args.tenant_id, preStart, today, to7];
    const bucketRows = await this.prisma.$queryRawUnsafe<
      Array<{
        overdue: bigint;
        today: bigint;
        next_7_days: bigint;
        later: bigint;
        unspecified: bigint;
      }>
    >(
      `SELECT
          count(*) FILTER (WHERE proposed_start_date IS NOT NULL AND proposed_start_date < $3::date)::bigint AS overdue,
          count(*) FILTER (WHERE proposed_start_date = $3::date)::bigint AS today,
          count(*) FILTER (WHERE proposed_start_date > $3::date AND proposed_start_date <= $4::date)::bigint AS next_7_days,
          count(*) FILTER (WHERE proposed_start_date > $4::date)::bigint AS later,
          count(*) FILTER (WHERE proposed_start_date IS NULL)::bigint AS unspecified
         FROM "placement"."PlacementProcess"
        WHERE tenant_id = $1::uuid
          AND state::text = ANY($2::text[])
          ${hasReq ? 'AND requisition_id = ANY($5::uuid[])' : ''}`,
      ...bucketParams,
    );

    // --- ContractAssignment lifecycle (BOUNDED / forward-materialized) ---
    const caParams: unknown[] = hasReq
      ? [args.tenant_id, [...args.requisition_ids!]]
      : [args.tenant_id];
    const caRows = await this.prisma.$queryRawUnsafe<
      Array<{ s: string; count: bigint }>
    >(
      // Track 7 / T7-PX §13 — a conversion ends the ContractAssignment with the genuine
      // domain reason CONVERTED_TO_PERMANENT, which MUST NOT be reported as ordinary
      // ENDED/attrition. Excluded here explicitly keyed on the reason (ACTIVE rows carry a
      // NULL end_reason, so IS DISTINCT FROM keeps them; ordinary ENDED reasons are kept).
      `SELECT lifecycle_state::text AS s, count(*)::bigint AS count
         FROM "placement"."ContractAssignment"
        WHERE tenant_id = $1::uuid
          AND lifecycle_state::text = ANY(ARRAY['ACTIVE','ENDED'])
          AND end_reason IS DISTINCT FROM 'CONVERTED_TO_PERMANENT'
          ${hasReq ? 'AND requisition_id = ANY($2::uuid[])' : ''}
        GROUP BY lifecycle_state`,
      ...caParams,
    );

    const b = bucketRows[0];
    const caBy = new Map(caRows.map((r) => [r.s, Number(r.count)]));
    return {
      by_state: byStateRows.map((r) => ({
        state: r.state,
        count: Number(r.count),
      })),
      start_date: {
        overdue: Number(b?.overdue ?? 0n),
        today: Number(b?.today ?? 0n),
        next_7_days: Number(b?.next_7_days ?? 0n),
        later: Number(b?.later ?? 0n),
        unspecified: Number(b?.unspecified ?? 0n),
      },
      contract_assignments: {
        active: caBy.get('ACTIVE') ?? 0,
        ended: caBy.get('ENDED') ?? 0,
      },
    };
  }
}
