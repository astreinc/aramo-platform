import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// T7-P4 — the placement-owned guarantee-EXPOSURE reporting aggregate (directive §3.6/§7).
// Reads historical exposure ONLY from the IMMUTABLE PermanentPlacement activation snapshot
// (guarantee_exposure_amount + guarantee_exposure_currency) — NEVER from the mutable
// PermanentPlacementGuaranteeTermVersion, and NEVER via deriveCommercialMetrics. Remedy
// obligation totals come from the immutable PermanentPlacementRemedy obligation facts. So a
// later P3 term revision cannot change an older placement's report value.
//
// Cohort = created_at (the immutable activation instant) in [from, to). Three BOUNDED SQL
// aggregates (GROUP BY currency + FILTER on lifecycle_state; LEFT-side is the cohort, the
// remedy table is JOINed for obligation sums) — tenant + A3-visible-requisition scoped, no
// N+1, no unbounded TypeScript fold. Money never crosses currencies: exposure and obligation
// sums are grouped by the exact stored currency and returned as scale-2 strings (Postgres
// preserves numeric scale; the caller never Number()s money). Zero-filling, at_risk aliasing,
// falloff_rate and the period echo are the reporting service's fold.

// The five states that descend from a qualifying falloff (§3.4). FELL_OFF is a transient
// intra-transaction state (atomically traversed to a *_DUE), so it is essentially never
// observed as a row value, but it is included for completeness.
const FELL_OFF_FAMILY = [
  'FELL_OFF',
  'REPLACEMENT_DUE',
  'REFUND_DUE',
  'PRORATED_CREDIT_DUE',
  'REMEDY_COMPLETED',
] as const;

export interface GuaranteeExposureSnapshot {
  cohort_count: number;
  // Per-currency exposure sums (scale-2 decimal strings). at_risk is derived (= active) by
  // the reporting service; the repository does not duplicate it.
  exposure_by_currency: Array<{
    currency: string;
    total: string;
    active: string;
    satisfied: string;
    fell_off: string;
  }>;
  states: {
    active: number;
    satisfied: number;
    fell_off: number;
    replacement_due: number;
    refund_due: number;
    prorated_credit_due: number;
    remedy_completed: number;
  };
  // Per-currency remedy obligation sums (REFUND + PRORATED_CREDIT only; REPLACEMENT has a
  // null/non-monetary amount and never appears here). Obligations, NOT payments.
  remedy_obligation_by_currency: Array<{
    currency: string;
    refund_total: string;
    prorated_credit_total: string;
  }>;
}

@Injectable()
export class GuaranteeExposureReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Aggregate the guarantee-exposure report for a cohort of PermanentPlacements whose
  // activation instant created_at is in [from, to). requisition_ids: undefined => see-all
  // within the tenant/site boundary; a non-empty array => filter on requisition_id; an
  // explicit empty array => the actor sees nothing (empty report).
  async readGuaranteeExposureSnapshot(args: {
    tenant_id: string;
    from: Date;
    to: Date;
    requisition_ids?: readonly string[];
  }): Promise<GuaranteeExposureSnapshot> {
    const empty: GuaranteeExposureSnapshot = {
      cohort_count: 0,
      exposure_by_currency: [],
      states: {
        active: 0,
        satisfied: 0,
        fell_off: 0,
        replacement_due: 0,
        refund_due: 0,
        prorated_credit_due: 0,
        remedy_completed: 0,
      },
      remedy_obligation_by_currency: [],
    };
    const hasReq = args.requisition_ids !== undefined;
    if (hasReq && args.requisition_ids!.length === 0) return empty;

    const fromIso = args.from.toISOString();
    const toIso = args.to.toISOString();
    const fellOff = [...FELL_OFF_FAMILY];

    // --- exposure by currency ($4 = fell-off family; $5 = optional visible requisitions) ---
    const expParams: unknown[] = hasReq
      ? [args.tenant_id, fromIso, toIso, fellOff, [...args.requisition_ids!]]
      : [args.tenant_id, fromIso, toIso, fellOff];
    const exposureRows = await this.prisma.$queryRawUnsafe<
      Array<{ currency: string; total: string; active: string; satisfied: string; fell_off: string }>
    >(
      `SELECT
          guarantee_exposure_currency AS currency,
          COALESCE(SUM(guarantee_exposure_amount), 0)::numeric(38,2)::text AS total,
          COALESCE(SUM(guarantee_exposure_amount) FILTER (WHERE lifecycle_state::text = 'GUARANTEE_ACTIVE'), 0)::numeric(38,2)::text AS active,
          COALESCE(SUM(guarantee_exposure_amount) FILTER (WHERE lifecycle_state::text = 'GUARANTEE_SATISFIED'), 0)::numeric(38,2)::text AS satisfied,
          COALESCE(SUM(guarantee_exposure_amount) FILTER (WHERE lifecycle_state::text = ANY($4::text[])), 0)::numeric(38,2)::text AS fell_off
         FROM "placement"."PermanentPlacement"
        WHERE tenant_id = $1::uuid
          AND created_at >= $2::timestamptz
          AND created_at < $3::timestamptz
          ${hasReq ? 'AND requisition_id = ANY($5::uuid[])' : ''}
        GROUP BY guarantee_exposure_currency
        ORDER BY guarantee_exposure_currency`,
      ...expParams,
    );

    // --- state counts (cohort_count = sum) ($4 = optional visible requisitions) ---
    const stateParams: unknown[] = hasReq
      ? [args.tenant_id, fromIso, toIso, [...args.requisition_ids!]]
      : [args.tenant_id, fromIso, toIso];
    const stateRows = await this.prisma.$queryRawUnsafe<Array<{ state: string; count: bigint }>>(
      `SELECT lifecycle_state::text AS state, count(*)::bigint AS count
         FROM "placement"."PermanentPlacement"
        WHERE tenant_id = $1::uuid
          AND created_at >= $2::timestamptz
          AND created_at < $3::timestamptz
          ${hasReq ? 'AND requisition_id = ANY($4::uuid[])' : ''}
        GROUP BY lifecycle_state`,
      ...stateParams,
    );

    // --- remedy obligations by currency (REFUND + PRORATED_CREDIT only) ---
    const remedyParams: unknown[] = hasReq
      ? [args.tenant_id, fromIso, toIso, [...args.requisition_ids!]]
      : [args.tenant_id, fromIso, toIso];
    const remedyRows = await this.prisma.$queryRawUnsafe<
      Array<{ currency: string; refund_total: string; prorated_credit_total: string }>
    >(
      `SELECT
          r.currency AS currency,
          COALESCE(SUM(r.calculated_amount) FILTER (WHERE r.remedy_type::text = 'REFUND'), 0)::numeric(38,2)::text AS refund_total,
          COALESCE(SUM(r.calculated_amount) FILTER (WHERE r.remedy_type::text = 'PRORATED_CREDIT'), 0)::numeric(38,2)::text AS prorated_credit_total
         FROM "placement"."PermanentPlacementRemedy" r
         JOIN "placement"."PermanentPlacement" p ON p.id = r.permanent_placement_id
        WHERE p.tenant_id = $1::uuid
          AND p.created_at >= $2::timestamptz
          AND p.created_at < $3::timestamptz
          AND r.currency IS NOT NULL
          ${hasReq ? 'AND p.requisition_id = ANY($4::uuid[])' : ''}
        GROUP BY r.currency
        ORDER BY r.currency`,
      ...remedyParams,
    );

    const stateBy = new Map(stateRows.map((r) => [r.state, Number(r.count)]));
    const countOf = (s: string): number => stateBy.get(s) ?? 0;
    let cohort = 0;
    for (const r of stateRows) cohort += Number(r.count);

    return {
      cohort_count: cohort,
      exposure_by_currency: exposureRows.map((r) => ({
        currency: r.currency,
        total: r.total,
        active: r.active,
        satisfied: r.satisfied,
        fell_off: r.fell_off,
      })),
      states: {
        active: countOf('GUARANTEE_ACTIVE'),
        satisfied: countOf('GUARANTEE_SATISFIED'),
        fell_off:
          countOf('FELL_OFF') +
          countOf('REPLACEMENT_DUE') +
          countOf('REFUND_DUE') +
          countOf('PRORATED_CREDIT_DUE') +
          countOf('REMEDY_COMPLETED'),
        replacement_due: countOf('REPLACEMENT_DUE'),
        refund_due: countOf('REFUND_DUE'),
        prorated_credit_due: countOf('PRORATED_CREDIT_DUE'),
        remedy_completed: countOf('REMEDY_COMPLETED'),
      },
      remedy_obligation_by_currency: remedyRows.map((r) => ({
        currency: r.currency,
        refund_total: r.refund_total,
        prorated_credit_total: r.prorated_credit_total,
      })),
    };
  }
}
