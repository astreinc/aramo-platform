import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import type { PlacementProcessEventView } from './placement-process.types.js';

interface PlacementProcessEventRow {
  id: string;
  tenant_id: string;
  placement_process_id: string;
  event_type: 'state_transition';
  event_payload: unknown;
  reason_code: string | null;
  reason_label_snapshot: string | null;
  reason_detail: string | null;
  created_at: Date;
}

function projectEventView(row: PlacementProcessEventRow): PlacementProcessEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    placement_process_id: row.placement_process_id,
    event_type: row.event_type,
    event_payload: row.event_payload,
    // E3 — reason evidence surfaced on the read view. Null = legacy/non-governed
    // absence, distinguished from a present canonical reason. reason_detail is
    // tenant-owned PII; an HTTP read surface (E1-d) must gate its exposure to
    // roles already permitted to see placement evidence.
    reason_code: row.reason_code ?? null,
    reason_label_snapshot: row.reason_label_snapshot ?? null,
    reason_detail: row.reason_detail ?? null,
    created_at: row.created_at,
  };
}

// PlacementProcessEventRepository — READ surface over the append-only event
// log (Track 3 / E1-a §9). Appends are written inline in the transition
// transaction (PlacementRepository); the log has no update or delete path
// here, and the database triggers reject both regardless (§3).
@Injectable()
export class PlacementProcessEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listEvents(tenant_id: string, placement_process_id: string): Promise<PlacementProcessEventView[]> {
    // E1-d — deterministic event ordering with a STABLE tie-breaker (created_at
    // asc, then id asc). The append-only log can carry two events at the same
    // timestamp; the id tie-break keeps the timeline order fixed for the read
    // surface and its Pact contract.
    const rows = (await this.prisma.placementProcessEvent.findMany({
      where: { tenant_id, placement_process_id },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    })) as PlacementProcessEventRow[];
    return rows.map(projectEventView);
  }

  // T9-B2 — fallthrough cohort aggregate for the reporting fallthrough report.
  // Governed by Aramo-T9-B2-Directive-v1_0-LOCKED. Placement owns this read (the
  // reporting lib consumes it over the existing reporting→placement edge; §11).
  //
  //   denominator = distinct PlacementProcess whose FIRST OFFER_ACCEPTED
  //     transition (MIN created_at where event_payload->>'to' = 'OFFER_ACCEPTED')
  //     falls in [from,to) (D-2/D-4);
  //   numerator   = those cohort attempts that later terminate in FELL_THROUGH
  //     or NO_SHOW ONLY (D-1) — OFFER_DECLINED (never accepted), OFFER_RESCINDED,
  //     STARTED and still-live are excluded;
  //   reason      = the terminal event's reason_code + reason_label_snapshot
  //     (D-3); reason_detail is NEVER selected (PII wall, §16).
  //
  // Tenant-scoped; `requisition_ids` applies the reporting-resolved A3 visible
  // set (undefined = tenant-wide see-all; empty = nothing visible → empty
  // cohort). Date-bounded, no N+1, no unbounded all-history fold (§12). Returns
  // one row per fallen-through attempt (placements are low-volume); the reporting
  // service folds the rate + reason group-by. First OFFER_ACCEPTED / DISTINCT ON
  // terminal make duplicate history rows non-double-counting (D-6).
  async readFallthroughCohort(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
    from: Date;
    to: Date;
  }): Promise<{
    accepted_attempts: number;
    fallthrough: Array<{
      reason_code: string | null;
      reason_label_snapshot: string | null;
    }>;
  }> {
    const hasReq = args.requisition_ids !== undefined;
    // An explicit empty visible-set means the actor sees no requisitions.
    if (hasReq && args.requisition_ids!.length === 0) {
      return { accepted_attempts: 0, fallthrough: [] };
    }
    const acceptedCte = `
      WITH accepted AS (
        SELECT e.placement_process_id AS pp, MIN(e.created_at) AS first_accepted_at
          FROM "placement"."PlacementProcessEvent" e
          JOIN "placement"."PlacementProcess" p ON p.id = e.placement_process_id
         WHERE e.tenant_id = $1::uuid
           AND e.event_type = 'state_transition'::"placement"."PlacementEventType"
           AND e.event_payload->>'to' = 'OFFER_ACCEPTED'
           ${hasReq ? 'AND p.requisition_id = ANY($4::uuid[])' : ''}
         GROUP BY e.placement_process_id
      ),
      cohort AS (
        SELECT pp FROM accepted
         WHERE first_accepted_at >= $2 AND first_accepted_at < $3
      )`;
    const params: unknown[] = hasReq
      ? [args.tenant_id, args.from, args.to, [...args.requisition_ids!]]
      : [args.tenant_id, args.from, args.to];

    const countRows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `${acceptedCte} SELECT count(*)::bigint AS n FROM cohort`,
      ...params,
    );
    const accepted_attempts = Number(countRows[0]?.n ?? 0n);

    const ftRows = await this.prisma.$queryRawUnsafe<
      Array<{ reason_code: string | null; reason_label_snapshot: string | null }>
    >(
      `${acceptedCte}
       SELECT DISTINCT ON (e.placement_process_id)
              e.reason_code, e.reason_label_snapshot
         FROM "placement"."PlacementProcessEvent" e
        WHERE e.tenant_id = $1::uuid
          AND e.event_type = 'state_transition'::"placement"."PlacementEventType"
          AND e.event_payload->>'to' IN ('FELL_THROUGH', 'NO_SHOW')
          AND e.placement_process_id IN (SELECT pp FROM cohort)
        ORDER BY e.placement_process_id, e.created_at ASC`,
      ...params,
    );

    return {
      accepted_attempts,
      fallthrough: ftRows.map((r) => ({
        reason_code: r.reason_code ?? null,
        reason_label_snapshot: r.reason_label_snapshot ?? null,
      })),
    };
  }

  // Lane 2 / L2-G — the CANONICAL fill read (D-1): fill = PlacementProcess *established*
  // (birth PRE_START = `PlacementProcess.created_at`), NOT the pipeline `placed` mirror.
  // Returns, per (talent_record_id, requisition_id), the FIRST established instant and
  // the FIRST STARTED instant (null if never started), collapsing duplicate placements
  // per triple (DISTINCT ON) exactly as the legacy `MIN(first_placed)` collapse did.
  // Placement OWNS this read; the reporting lib folds it over the existing
  // reporting→placement edge (the T9-B2/B3/B4 precedent). Tenant-scoped; `requisition_ids`
  // applies the reporting-resolved A3 visible set (undefined = tenant-wide; empty =
  // nothing visible → empty cohort). Date-bounded on the FIRST-established instant.
  // Time-to-Fill (opened→established) and Time-to-Start (established→STARTED) are the
  // reporting fold; this read supplies both instants. No pipeline read; no schema change.
  async readFillCohort(args: {
    tenant_id: string;
    requisition_ids?: readonly string[];
    // Optional window on the FIRST-established instant. Both omitted = no date filter
    // (the req-cohort / tenant scope is the bound) — the fill-performance + placement-
    // count + company readers window by requisition, not by established date; only the
    // recruiter-monthly series windows by established instant.
    from?: Date;
    to?: Date;
  }): Promise<
    Array<{
      requisition_id: string;
      talent_record_id: string;
      first_placement_process_id: string;
      first_established_at: Date;
      first_started_at: Date | null;
    }>
  > {
    const hasReq = args.requisition_ids !== undefined;
    if (hasReq && args.requisition_ids!.length === 0) {
      return [];
    }
    const hasWindow = args.from !== undefined && args.to !== undefined;
    // Params: $1 tenant; then optional window ($2 from, $3 to); then optional req array.
    const params: unknown[] = [args.tenant_id];
    if (hasWindow) params.push(args.from, args.to);
    const reqParamIndex = params.length + 1; // next positional slot for the req array
    if (hasReq) params.push([...args.requisition_ids!]);

    // established = the FIRST PlacementProcess per (talent, req) (birth PRE_START) — its
    // created_at (fill instant) + id (DISTINCT ON earliest, id-tiebreak for stability);
    // started = first STARTED-event created_at per (talent, req), joined by placement.
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        requisition_id: string;
        talent_record_id: string;
        first_placement_process_id: string;
        first_established_at: Date;
        first_started_at: Date | null;
      }>
    >(
      `WITH established AS (
         SELECT DISTINCT ON (p.requisition_id, p.talent_record_id)
                p.requisition_id, p.talent_record_id,
                p.id AS first_placement_process_id,
                p.created_at AS first_established_at
           FROM "placement"."PlacementProcess" p
          WHERE p.tenant_id = $1::uuid
            ${hasReq ? `AND p.requisition_id = ANY($${reqParamIndex}::uuid[])` : ''}
          ORDER BY p.requisition_id, p.talent_record_id, p.created_at ASC, p.id ASC
       ),
       cohort AS (
         SELECT * FROM established
          ${hasWindow ? 'WHERE first_established_at >= $2 AND first_established_at < $3' : ''}
       ),
       started AS (
         SELECT p.requisition_id, p.talent_record_id,
                MIN(e.created_at) AS first_started_at
           FROM "placement"."PlacementProcessEvent" e
           JOIN "placement"."PlacementProcess" p ON p.id = e.placement_process_id
          WHERE e.tenant_id = $1::uuid
            AND e.event_type = 'state_transition'::"placement"."PlacementEventType"
            AND e.event_payload->>'to' = 'STARTED'
          GROUP BY p.requisition_id, p.talent_record_id
       )
       SELECT c.requisition_id, c.talent_record_id,
              c.first_placement_process_id,
              c.first_established_at,
              s.first_started_at
         FROM cohort c
         LEFT JOIN started s
           ON s.requisition_id = c.requisition_id
          AND s.talent_record_id = c.talent_record_id
        ORDER BY c.requisition_id, c.talent_record_id`,
      ...params,
    );
    return rows.map((r) => ({
      requisition_id: r.requisition_id,
      talent_record_id: r.talent_record_id,
      first_placement_process_id: r.first_placement_process_id,
      first_established_at: r.first_established_at,
      first_started_at: r.first_started_at ?? null,
    }));
  }
}
