import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { Prisma } from '../../prisma/generated/client/client.js';

import { deriveCommercialMetrics } from './commercial/commercial-metrics.js';
import { PrismaService } from './prisma/prisma.service.js';

// One homogeneous (currency, rate_period) margin group. `group_margin_percent` is
// the GOVERNED aggregate (T9-B4 §8 D-5): the bill-rate-weighted margin of the group,
// derived from Decimal numerator/denominator TOTALS — never the mean of already-
// rounded per-assignment percentages. `assignment_count` is the number of
// commercialized assignments folded into the group.
//
// Field name is `group_margin_percent` (NOT `margin_percent`) per
// Aramo-T9-B4-Margin-Field-Masking-Amendment-v1_0-LOCKED: the row-level name
// `margin_percent` is in the closed COMPENSATION_FIELD_KEYS catalog and would be
// stripped by the global D5 CompensationFieldMaskInterceptor. The distinct name
// avoids that collision AND makes the aggregate (vs per-record) meaning explicit.
export interface CommercialMarginGroup {
  currency: string;
  rate_period: string;
  assignment_count: number;
  group_margin_percent: string | null;
}

// Current-snapshot margin aggregate over eligible CONTRACT assignments. Coverage
// is FORWARD_MATERIALIZED: eligible = commercialized + missing (T9-B4 §6 D-3). The
// caller stamps the coverage label; this repository owns the counts + the
// commercial arithmetic.
export interface CommercialMarginSnapshot {
  eligible_count: number;
  commercialized_count: number;
  missing_commercial_count: number;
  groups: CommercialMarginGroup[];
}

// Canonical rate-period ordering (T9-B4 §10 / §13) — deterministic group order is
// currency ASC, then this fixed period order. rate_period is a grouping key only;
// no monetary value is ever summed across heterogeneous periods (no annualization,
// no normalization substrate exists).
const RATE_PERIOD_ORDER: Record<string, number> = {
  HOURLY: 0,
  DAILY: 1,
  WEEKLY: 2,
  MONTHLY: 3,
  ANNUAL: 4,
};

function ratePeriodRank(rp: string): number {
  return RATE_PERIOD_ORDER[rp] ?? Number.MAX_SAFE_INTEGER;
}

// T9-B4 — placement-owned READ-side commercial margin aggregate for the reporting
// margin view. Governed by Aramo-T9-B4-Directive-v1_0-LOCKED (§7/§8/§19/§20).
//
// Narrow, additive, read-only boundary (NO broad PlacementRepository injection,
// §19). Set-based (NO per-assignment N+1, §20): three tenant + A3-visible-req
// scoped aggregates over ACTIVE CONTRACT `ContractAssignment` joined to its CURRENT
// non-cancelled effective `AssignmentRateVersion`:
//   1. an ambiguity GUARD — >1 current effective version for any one assignment is
//      a corrupt/ambiguous commercial state; FAIL CLOSED (the same server-integrity
//      convention as PlacementRepository.findAssignmentCommercialProjection), NEVER
//      a latest-wins winner and NEVER a double-counted group;
//   2. the group aggregate — Decimal SUM(pay)/SUM(bill) per (currency, rate_period),
//      then `deriveCommercialMetrics(sumPay, sumBill).margin_percent` (the ONE
//      canonical arithmetic home; consuming the sums yields SUM(bill-pay)/SUM(bill)
//      *100 with the same zero-bill→null contract — no reimplementation);
//   3. the eligible count — every ACTIVE CONTRACT assignment in the visible set,
//      so missing_commercial = eligible - commercialized is counted, not dropped.
// PermanentPlacement is a separate aggregate/table and never participates. ENDED and
// future/cancelled-only versions carry no CURRENT effective row and drop out.
@Injectable()
export class CommercialMarginReadRepository {
  constructor(private readonly prisma: PrismaService) {}

  async readCurrentMarginSnapshot(args: {
    tenant_id: string;
    requestId: string;
    requisition_ids?: readonly string[];
    now?: Date;
  }): Promise<CommercialMarginSnapshot> {
    const empty: CommercialMarginSnapshot = {
      eligible_count: 0,
      commercialized_count: 0,
      missing_commercial_count: 0,
      groups: [],
    };
    const hasReq = args.requisition_ids !== undefined;
    // An explicit empty visible-set means the actor sees no requisitions.
    if (hasReq && args.requisition_ids!.length === 0) return empty;

    const now = args.now ?? new Date();

    // --- (1) ambiguity GUARD — fail closed on any assignment with >1 current
    // effective non-cancelled version. Detected set-wide; never repaired here. ---
    const ambiguousParams: unknown[] = hasReq
      ? [args.tenant_id, now, [...args.requisition_ids!]]
      : [args.tenant_id, now];
    const ambiguous = await this.prisma.$queryRawUnsafe<
      Array<{ assignment_id: string; n: bigint }>
    >(
      `SELECT ca.id::text AS assignment_id, count(*)::bigint AS n
         FROM "placement"."ContractAssignment" ca
         JOIN "placement"."AssignmentRateVersion" arv
           ON arv.contract_assignment_id = ca.id AND arv.tenant_id = ca.tenant_id
        WHERE ca.tenant_id = $1::uuid
          AND ca.lifecycle_state::text = 'ACTIVE'
          AND arv.cancelled_at IS NULL
          AND arv.effective_from <= $2::timestamptz
          AND (arv.effective_to IS NULL OR arv.effective_to > $2::timestamptz)
          ${hasReq ? 'AND ca.requisition_id = ANY($3::uuid[])' : ''}
        GROUP BY ca.id
       HAVING count(*) > 1
        LIMIT 1`,
      ...ambiguousParams,
    );
    if (ambiguous.length > 0) {
      // >1 effective version = corrupt/ambiguous commercial state. FAIL CLOSED — a
      // server-integrity error (INTERNAL_ERROR / 500), never a silently-chosen
      // winner and never a double-counted aggregate. No competing financial values
      // in the payload (only the anchor + reason).
      throw new AramoError(
        'INTERNAL_ERROR',
        'ambiguous commercial version state: more than one effective AssignmentRateVersion',
        500,
        {
          requestId: args.requestId,
          details: {
            contract_assignment_id: ambiguous[0]!.assignment_id,
            reason: 'commercial_version_ambiguity',
          },
        },
      );
    }

    // --- (2) group aggregate — Decimal SUM(pay)/SUM(bill) per (currency,
    // rate_period). SUM cast ::text preserves Decimal precision (no float). After
    // the guard each assignment contributes AT MOST ONE current version, so the
    // join can never double-count within a group. ---
    const groupParams: unknown[] = hasReq
      ? [args.tenant_id, now, [...args.requisition_ids!]]
      : [args.tenant_id, now];
    const groupRows = await this.prisma.$queryRawUnsafe<
      Array<{
        currency: string;
        rate_period: string;
        assignment_count: bigint;
        sum_pay: string;
        sum_bill: string;
      }>
    >(
      `SELECT arv.currency AS currency,
              arv.rate_period AS rate_period,
              count(*)::bigint AS assignment_count,
              SUM(arv.pay_rate_amount)::text AS sum_pay,
              SUM(arv.bill_rate_amount)::text AS sum_bill
         FROM "placement"."ContractAssignment" ca
         JOIN "placement"."AssignmentRateVersion" arv
           ON arv.contract_assignment_id = ca.id AND arv.tenant_id = ca.tenant_id
        WHERE ca.tenant_id = $1::uuid
          AND ca.lifecycle_state::text = 'ACTIVE'
          AND arv.cancelled_at IS NULL
          AND arv.effective_from <= $2::timestamptz
          AND (arv.effective_to IS NULL OR arv.effective_to > $2::timestamptz)
          ${hasReq ? 'AND ca.requisition_id = ANY($3::uuid[])' : ''}
        GROUP BY arv.currency, arv.rate_period`,
      ...groupParams,
    );

    // --- (3) eligible count — all ACTIVE CONTRACT assignments in the visible set. ---
    const eligibleParams: unknown[] = hasReq
      ? [args.tenant_id, [...args.requisition_ids!]]
      : [args.tenant_id];
    const eligibleRows = await this.prisma.$queryRawUnsafe<
      Array<{ n: bigint }>
    >(
      `SELECT count(*)::bigint AS n
         FROM "placement"."ContractAssignment" ca
        WHERE ca.tenant_id = $1::uuid
          AND ca.lifecycle_state::text = 'ACTIVE'
          ${hasReq ? 'AND ca.requisition_id = ANY($2::uuid[])' : ''}`,
      ...eligibleParams,
    );

    const groups: CommercialMarginGroup[] = groupRows
      .map((r) => {
        // The GOVERNED aggregate: consume the canonical deriver on the Decimal
        // TOTALS. deriveCommercialMetrics(sumPay, sumBill).margin_percent
        // === (sumBill - sumPay) / sumBill * 100, null when sumBill == 0. Surfaced
        // under the aggregate name `group_margin_percent` (amendment §2).
        const metrics = deriveCommercialMetrics(
          new Prisma.Decimal(r.sum_pay),
          new Prisma.Decimal(r.sum_bill),
        );
        return {
          currency: r.currency,
          rate_period: r.rate_period,
          assignment_count: Number(r.assignment_count),
          group_margin_percent: metrics.margin_percent,
        };
      })
      .sort(
        (a, b) =>
          a.currency.localeCompare(b.currency) ||
          ratePeriodRank(a.rate_period) - ratePeriodRank(b.rate_period),
      );

    const eligible_count = Number(eligibleRows[0]?.n ?? 0n);
    const commercialized_count = groups.reduce(
      (sum, g) => sum + g.assignment_count,
      0,
    );
    return {
      eligible_count,
      commercialized_count,
      missing_commercial_count: eligible_count - commercialized_count,
      groups,
    };
  }
}
