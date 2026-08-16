import { Injectable, Logger } from '@nestjs/common';
import { ActivityRepository } from '@aramo/activity';
import { CalendarRepository } from '@aramo/calendar';
import type { VisibilityContextShape } from '@aramo/common';
import { CompanyRepository } from '@aramo/company';
import { ContactRepository } from '@aramo/contact';
import { PipelineRepository } from '@aramo/pipeline';
import {
  CapacityProjectionRepository,
  type CapacityProjection,
  PlacementProcessEventRepository,
  AssignmentPipelineReadRepository,
  GuaranteeExposureReadRepository,
  CommercialMarginReadRepository,
} from '@aramo/placement';
import { RequisitionRepository } from '@aramo/requisition';
import { SavedListRepository } from '@aramo/saved-list';
import {
  KNOWN_SETTINGS,
  TenantSettingRepository,
  isMetricGoalMap,
} from '@aramo/settings';
import { TalentRecordRepository } from '@aramo/talent-record';

import type {
  AssignmentPipelineReportView,
  CompanyMetricsView,
  CompanyPlacementView,
  DashboardView,
  FallthroughReasonView,
  FallthroughReportView,
  FillPerformanceReportView,
  GuaranteeExposureReportView,
  MarginReportView,
  PipelineStageRollupView,
  PlacementCountReportView,
  RecruiterMetricKey,
  RecruiterMetricView,
  RequisitionStatusRollupView,
  TenantCountsReportView,
} from './dto/report.view.js';

// ReportingService — PR-A7 Gate 5 — ATS-INTERNAL ONLY.
//
// === Seam-exclusion (the load-bearing architectural property) ===
//
// This service is the central A7 read-aggregator. It composes counts +
// rollups over the 8 ATS-side schemas only:
//   company / contact / requisition / pipeline / activity / calendar
//   / saved_list / talent_record.
//
// It NEVER reads (and is structurally incapable of reading) any Core /
// engagement / submittal / examination / matching / talent / job_domain
// schema:
//   - The DI inputs are exactly the 8 ATS-domain repositories. There is
//     no @aramo/selection / @aramo/submittal / @aramo/examination /
//     @aramo/talent / @aramo/job-domain import in this lib (enforced
//     by tsconfig.lib.json paths + lint:nx-boundaries + the A7
//     integration spec's seam-exclusion structural assertion).
//   - The dashboard's "placement" metric is the ATS-internal
//     placed-pipeline view (the A5b-1 terminal state), NOT a
//     submittal-confirmed-placement (which would require crossing the
//     seam — that's T5, judgment-out, M6-gated).
//
// === Role-visibility (the A3 shape) ===
//
// Per Ruling 2 (A3): visibility is a query predicate, NOT a guard
// rejection. Both `requisition:read` (recruiter) and
// `requisition:read:all` (tenant_admin) pass @RequireScopes; the rows
// they SEE differ:
//   - tenant_admin (`requisition:read:all`) → tenant-wide view of
//     requisition + pipeline rollups.
//   - recruiter (`requisition:read` only) → only requisitions assigned
//     to AuthContext.sub (the A3 predicate), and only pipelines on
//     those visible requisitions.
//
// The A3 predicate is applied INSIDE the requisition repo
// (`countForActor` / `countByStatusForActor`) for requisitions, and at
// THIS SERVICE LAYER for pipelines (we resolve the visible
// requisition_ids first, then constrain pipeline queries). This
// cross-schema composition is necessary because pipeline.requisition_id
// is a logical UUID ref — Prisma cannot traverse the assignment
// relation across PG schemas.
//
// Reference-entity counts (company / contact / talent_record /
// saved_list / calendar / activity) are tenant-wide for both roles —
// A3 visibility applies to the recruiter-assignment domain only, NOT
// to the reference-data surface.

interface ActorContext {
  tenant_id: string;
  user_id: string;
  scopes: readonly string[];
  site_id?: string;
  // AUTHZ-D4b — composed visibility predicate result, resolved upstream
  // at the controller boundary (via req.resolveVisibility()) and passed
  // through. Replaces the prior actor_scopes / actor_user_id thread for
  // the requisition / pipeline scoping.
  visibility: VisibilityContextShape;
}

// The four desk KPI keys (used to pick the known goals out of the loose
// settings map). Mirrors RecruiterMetricKey.
const RECRUITER_METRIC_KEYS: readonly RecruiterMetricKey[] = [
  'submittals_weekly',
  'interviews_weekly',
  'placements_monthly',
  'avg_time_to_submit',
];

// --- recruiter-metrics windowing (pure helpers; `now` is injected so the
// service stays deterministic under test) ---
const DAY_MS = 86_400_000;
const SERIES_WEEKS = 8;
const SERIES_MONTHS = 6;

interface TransitionRow {
  readonly pipeline_id: string;
  readonly changed_at: Date;
}

function daysAgo(now: Date, n: number): Date {
  return new Date(now.getTime() - n * DAY_MS);
}
function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addMonthsUTC(base: Date, n: number): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + n, 1));
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
// Half-open [from, to) count.
function countIn(rows: readonly TransitionRow[], from: Date, to: Date): number {
  const f = from.getTime();
  const t = to.getTime();
  let n = 0;
  for (const r of rows) {
    const c = r.changed_at.getTime();
    if (c >= f && c < t) n += 1;
  }
  return n;
}

function weeklyCountMetric(
  rows: readonly TransitionRow[],
  now: Date,
  goal: number | undefined,
): Omit<RecruiterMetricView, 'key' | 'period'> {
  const nowPlus = new Date(now.getTime() + 1);
  const value = countIn(rows, daysAgo(now, 7), nowPlus);
  const previous = countIn(rows, daysAgo(now, 14), daysAgo(now, 7));
  const series: number[] = [];
  for (let i = SERIES_WEEKS - 1; i >= 0; i -= 1) {
    const end = i === 0 ? nowPlus : daysAgo(now, i * 7);
    series.push(countIn(rows, daysAgo(now, (i + 1) * 7), end));
  }
  return { value, previous, series, goal: goal ?? null };
}

function monthlyCountMetric(
  rows: readonly TransitionRow[],
  now: Date,
  goal: number | undefined,
): Omit<RecruiterMetricView, 'key' | 'period'> {
  const nowPlus = new Date(now.getTime() + 1);
  const somNow = startOfMonthUTC(now);
  const value = countIn(rows, somNow, nowPlus);
  const somPrev = addMonthsUTC(now, -1);
  const elapsed = now.getTime() - somNow.getTime();
  const previous = countIn(rows, somPrev, new Date(somPrev.getTime() + elapsed));
  const series: number[] = [];
  for (let i = SERIES_MONTHS - 1; i >= 0; i -= 1) {
    const start = addMonthsUTC(now, -i);
    const end = i === 0 ? nowPlus : addMonthsUTC(now, -(i - 1));
    series.push(countIn(rows, start, end));
  }
  return { value, previous, series, goal: goal ?? null };
}

function weeklyAvgDaysMetric(
  submitted: ReadonlyArray<TransitionRow>,
  createdById: ReadonlyMap<string, Date>,
  now: Date,
  goal: number | undefined,
): Omit<RecruiterMetricView, 'key' | 'period'> {
  const avgIn = (from: Date, to: Date): number | null => {
    const f = from.getTime();
    const t = to.getTime();
    const durs: number[] = [];
    for (const r of submitted) {
      const c = r.changed_at.getTime();
      if (c < f || c >= t) continue;
      const created = createdById.get(r.pipeline_id);
      if (created === undefined) continue;
      const days = (c - created.getTime()) / DAY_MS;
      if (days >= 0) durs.push(days);
    }
    if (durs.length === 0) return null;
    return round1(durs.reduce((a, b) => a + b, 0) / durs.length);
  };
  const nowPlus = new Date(now.getTime() + 1);
  const value = avgIn(daysAgo(now, 7), nowPlus);
  const previous = avgIn(daysAgo(now, 14), daysAgo(now, 7));
  const series: number[] = [];
  for (let i = SERIES_WEEKS - 1; i >= 0; i -= 1) {
    const end = i === 0 ? nowPlus : daysAgo(now, i * 7);
    series.push(avgIn(daysAgo(now, (i + 1) * 7), end) ?? 0);
  }
  return { value, previous, series, goal: goal ?? null };
}

@Injectable()
export class ReportingService {
  private readonly logger = new Logger(ReportingService.name);

  constructor(
    private readonly companyRepository: CompanyRepository,
    private readonly contactRepository: ContactRepository,
    private readonly talentRecordRepository: TalentRecordRepository,
    private readonly savedListRepository: SavedListRepository,
    private readonly calendarRepository: CalendarRepository,
    private readonly activityRepository: ActivityRepository,
    private readonly requisitionRepository: RequisitionRepository,
    private readonly pipelineRepository: PipelineRepository,
    private readonly tenantSettingRepository: TenantSettingRepository,
    // Track 4 / T4-B1 — the placement-owned capacity projection, PULLED via the
    // declared reporting->placement edge (§4). CASE A (exposure, not migration):
    // the getCompanyMetrics `filled` aggregate STILL reads the stored
    // openings_available; this only makes the derived value ACCESSIBLE. The batch
    // migration (countActiveByRequisitionIds, one query) is T4-B2. Trailing param.
    private readonly capacity: CapacityProjectionRepository,
    // T9-B2 — the placement-owned fallthrough cohort read, PULLED via the
    // existing reporting→placement edge (§11). Trailing param (ctor-ripple
    // contained). Provided by PlacementEventReadModule.
    private readonly placementEventRepository: PlacementProcessEventRepository,
    // T9-B3 — the placement-owned current-state assignment-pipeline snapshot,
    // PULLED via the reporting→placement edge (§14). Trailing param
    // (ctor-ripple contained). Provided by PlacementPipelineReadModule.
    private readonly placementPipelineRepository: AssignmentPipelineReadRepository,
    // T7-P4 — the placement-owned guarantee-exposure aggregate, PULLED via the same
    // reporting→placement edge (§3.6). Trailing param (ctor-ripple contained). Read-only over
    // the immutable PermanentPlacement snapshot + remedy facts. Provided by
    // GuaranteeExposureReadModule.
    private readonly guaranteeExposureRepository: GuaranteeExposureReadRepository,
    // T9-B4 — the placement-owned current-snapshot commercial margin aggregate,
    // PULLED via the reporting→placement edge (§19). Trailing param (ctor-ripple
    // contained). Provided by CommercialMarginReadModule.
    private readonly commercialMarginRepository: CommercialMarginReadRepository,
  ) {}

  // Track 4 / T4-B1 (CASE A access) — single-requisition derived capacity, PULLED
  // from placement. Coexists with the stored openings_available the aggregates
  // still consume; nothing is migrated here. The N-read aggregate shape belongs to
  // T4-B2 as a batch projection owned by libs/placement, never a loop here.
  async readRequisitionCapacity(
    tenant_id: string,
    requisition_id: string,
    openings: number,
  ): Promise<CapacityProjection> {
    return this.capacity.projectCapacity(tenant_id, requisition_id, openings);
  }

  // -------------------------------------------------------------------------
  // Individual report endpoints (each route on ReportingController calls one)
  // -------------------------------------------------------------------------

  async getTenantCounts(actor: ActorContext): Promise<TenantCountsReportView> {
    const [
      companies,
      contacts,
      talent_records,
      saved_lists,
      calendar_events,
      activities,
    ] = await Promise.all([
      this.companyRepository.count({
        tenant_id: actor.tenant_id,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
      this.contactRepository.count({
        tenant_id: actor.tenant_id,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
      this.talentRecordRepository.count({
        tenant_id: actor.tenant_id,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
      this.savedListRepository.count({
        tenant_id: actor.tenant_id,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
      this.calendarRepository.count({
        tenant_id: actor.tenant_id,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
      this.activityRepository.count({ tenant_id: actor.tenant_id }),
    ]);
    return {
      companies,
      contacts,
      talent_records,
      saved_lists,
      calendar_events,
      activities,
    };
  }

  async getRequisitionRollup(
    actor: ActorContext,
  ): Promise<RequisitionStatusRollupView> {
    const [total, by_status] = await Promise.all([
      this.requisitionRepository.countForActor({
        tenant_id: actor.tenant_id,
        visibility: actor.visibility,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
      this.requisitionRepository.countByStatusForActor({
        tenant_id: actor.tenant_id,
        visibility: actor.visibility,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
    ]);
    return { total, by_status };
  }

  async getPipelineRollup(
    actor: ActorContext,
  ): Promise<PipelineStageRollupView> {
    const visibleReqIds = await this.resolveVisibleRequisitionIds(actor);
    // E6 Q-4 — by_status collapses each (talent, req) to its CURRENT episode; total
    // is the distinct-triple count (sum of the collapsed buckets), NOT a raw row
    // count, so a re-entered talent is counted once.
    const by_status = await this.pipelineRepository.countByStatus({
      tenant_id: actor.tenant_id,
      ...(visibleReqIds === undefined ? {} : { requisition_ids: visibleReqIds }),
    });
    const total = by_status.reduce((sum, r) => sum + r.count, 0);
    return { total, by_status };
  }

  async getPlacementCount(
    actor: ActorContext,
  ): Promise<PlacementCountReportView> {
    const visibleReqIds = await this.resolveVisibleRequisitionIds(actor);
    // E6 Q-4 — distinct (talent, req) with a placed episode EXISTS (a placement is a
    // fact about a human on a requisition, counted once even if re-placed).
    const placed_pipelines = await this.pipelineRepository.countDistinctPlaced({
      tenant_id: actor.tenant_id,
      ...(visibleReqIds === undefined ? {} : { requisition_ids: visibleReqIds }),
    });
    return {
      placed_pipelines,
      includes_core_submittal_placements: false,
    };
  }

  // -------------------------------------------------------------------------
  // T9-B1 — authoritative fill-rate + time-to-fill operational report.
  // Governed by Aramo-T9-B1-Directive-v1_0-LOCKED + the Gate-5 Finalization
  // Amendment. Fill authority = ATS pipeline terminal `placed` (D-1), NOT the
  // rejected capacity-derived `openings - openings_available` and NOT ACTIVE
  // ContractAssignment. Cohort = requisitions with created_at ∈ [from,to)
  // (D-3); `canceled` reqs are excluded from BOTH numerator and denominator
  // (§4). Time-to-fill = the Nth-distinct first-`placed` completion, N =
  // openings (D-2/§5) — only fully-filled reqs contribute (§6). Computed on
  // read over TWO date/cohort-bounded repository reads (D-6); no
  // materialization, no migration, no proxy.
  // -------------------------------------------------------------------------
  async getFillPerformance(
    actor: ActorContext,
    period: { from: Date; to: Date },
  ): Promise<FillPerformanceReportView> {
    const cohortAll = await this.requisitionRepository.listCohortForActor({
      tenant_id: actor.tenant_id,
      visibility: actor.visibility,
      from: period.from,
      to: period.to,
      ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
    });
    // §4 — canceled requisitions are excluded from numerator AND denominator.
    // Every other status (open / on_hold / submittals_closed / closed / …)
    // stays in the denominator; `closed` is NOT synonymous with filled.
    const cohort = cohortAll.filter((r) => r.status !== 'canceled');

    const placedRows =
      cohort.length === 0
        ? []
        : await this.pipelineRepository.listFirstPlacedByRequisitions({
            tenant_id: actor.tenant_id,
            requisition_ids: cohort.map((r) => r.id),
          });

    // Group first-placed instants by requisition. Each row is already ONE
    // distinct talent (MIN(changed_at) per (talent, req) applied upstream),
    // so per-req array length == distinct placed talents.
    const placedByReq = new Map<string, Date[]>();
    for (const row of placedRows) {
      const arr = placedByReq.get(row.requisition_id);
      if (arr === undefined) {
        placedByReq.set(row.requisition_id, [row.first_placed_at]);
      } else {
        arr.push(row.first_placed_at);
      }
    }

    let openingsTotal = 0;
    let filledTotal = 0;
    let fullyFilled = 0;
    const ttfDays: number[] = [];

    for (const req of cohort) {
      const openings = req.openings;
      openingsTotal += openings;
      const firstPlaced = placedByReq.get(req.id) ?? [];
      const distinctPlaced = firstPlaced.length;
      // §3 — clamp: never count filled openings above declared openings.
      filledTotal += Math.min(distinctPlaced, openings);
      // §5/§6 — ONLY a fully filled requisition has a time-to-fill.
      if (openings > 0 && distinctPlaced >= openings) {
        fullyFilled += 1;
        // Completion = the Nth distinct talent's FIRST placed instant
        // (N = openings) — the moment the last required opening filled.
        const ordered = [...firstPlaced].sort(
          (a, b) => a.getTime() - b.getTime(),
        );
        // distinctPlaced ≥ openings ≥ 1 guarantees this index exists; the
        // explicit guard satisfies noUncheckedIndexedAccess.
        const completion = ordered[openings - 1];
        if (completion !== undefined) {
          const days =
            (completion.getTime() - req.created_at.getTime()) / DAY_MS;
          // A fully-filled req cannot complete before it was created; guard
          // clock skew rather than emit a negative duration.
          if (days >= 0) ttfDays.push(days);
        }
      }
    }

    const fill_rate =
      openingsTotal > 0
        ? Math.round((filledTotal / openingsTotal) * 100)
        : null;
    const ttfCount = ttfDays.length;
    const average_days =
      ttfCount > 0
        ? round1(ttfDays.reduce((a, b) => a + b, 0) / ttfCount)
        : null;

    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      openings: openingsTotal,
      filled_openings: filledTotal,
      fill_rate,
      fully_filled_requisitions: fullyFilled,
      time_to_fill: { count: ttfCount, average_days },
    };
  }

  // -------------------------------------------------------------------------
  // T9-B2 — authoritative fallthrough-rate + reasons operational report.
  // Governed by Aramo-T9-B2-Directive-v1_0-LOCKED. Placement-attempt level,
  // post-acceptance/pre-start only. The placement lib owns the date-bounded
  // cohort read (first OFFER_ACCEPTED ∈ [from,to); terminal FELL_THROUGH/NO_SHOW
  // with reason_code/reason_label_snapshot — NEVER reason_detail); this service
  // folds the rate + the reason group-by. A3 visibility is resolved here and
  // passed as the requisition-id constraint (undefined = tenant-wide see-all).
  // No materialization, no migration, no proxy.
  // -------------------------------------------------------------------------
  async getFallthrough(
    actor: ActorContext,
    period: { from: Date; to: Date },
  ): Promise<FallthroughReportView> {
    // T9-B5 / AV-1 — explicit site narrows even for see_all principals.
    const visibleReqIds = await this.resolveSiteNarrowedRequisitionIds(actor);
    const cohort = await this.placementEventRepository.readFallthroughCohort({
      tenant_id: actor.tenant_id,
      from: period.from,
      to: period.to,
      ...(visibleReqIds === undefined ? {} : { requisition_ids: visibleReqIds }),
    });

    const accepted_attempts = cohort.accepted_attempts;
    const fallthrough_attempts = cohort.fallthrough.length;
    const fallthrough_rate =
      accepted_attempts > 0
        ? Math.round((fallthrough_attempts / accepted_attempts) * 100)
        : null;

    // Group the fallthrough terminals by canonical reason_code. A null
    // reason_code (legacy/unrecorded — the migration CHECK pairs code↔label, so
    // a null code implies a null label) folds into the report-only "Unspecified"
    // bucket (D-8); it is never written back to placement or the registry.
    const buckets = new Map<
      string | null,
      { reason_label: string; count: number }
    >();
    for (const f of cohort.fallthrough) {
      const existing = buckets.get(f.reason_code);
      if (existing !== undefined) {
        existing.count += 1;
      } else {
        buckets.set(f.reason_code, {
          reason_label:
            f.reason_code === null
              ? 'Unspecified'
              : (f.reason_label_snapshot ?? 'Unspecified'),
          count: 1,
        });
      }
    }

    const reasons: FallthroughReasonView[] =
      fallthrough_attempts === 0
        ? []
        : [...buckets.entries()]
            .map(([reason_code, b]) => ({
              reason_code,
              reason_label: b.reason_label,
              count: b.count,
              rate: Math.round((b.count / fallthrough_attempts) * 100),
            }))
            // Deterministic contract order: most frequent first, then reason_code
            // ascending (the null "Unspecified" bucket sorts last).
            .sort(
              (a, b) =>
                b.count - a.count ||
                (a.reason_code ?? '￿').localeCompare(
                  b.reason_code ?? '￿',
                ),
            );

    return {
      period: {
        from: period.from.toISOString(),
        to: period.to.toISOString(),
      },
      accepted_attempts,
      fallthrough_attempts,
      fallthrough_rate,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // T9-B3 — assignment-pipeline current-snapshot operational view. Governed by
  // Aramo-T9-B3-Directive-v1_0-LOCKED. Placement owns the current-state aggregate
  // (readAssignmentPipelineSnapshot over PlacementProcess.state +
  // proposed_start_date + bounded ContractAssignment); this service zero-fills
  // the FIVE live states in fixed lifecycle order, computes total_live as their
  // exact sum (§10 — the contract_assignments block never contributes), and
  // stamps the UTC / forward-materialized coverage labels. Counts-only, no rows,
  // no from/to, no commercial data. report:read + tenant/site/A3.
  // -------------------------------------------------------------------------
  async getAssignmentPipeline(
    actor: ActorContext,
    opts?: { now?: Date },
  ): Promise<AssignmentPipelineReportView> {
    // T9-B5 / AV-1 — explicit site narrows even for see_all principals.
    const visibleReqIds = await this.resolveSiteNarrowedRequisitionIds(actor);
    const snapshot =
      await this.placementPipelineRepository.readAssignmentPipelineSnapshot({
        tenant_id: actor.tenant_id,
        now: opts?.now ?? new Date(),
        ...(visibleReqIds === undefined
          ? {}
          : { requisition_ids: visibleReqIds }),
      });

    const counts = new Map(snapshot.by_state.map((r) => [r.state, r.count]));
    // Fixed lifecycle order; zero-filled; the five live states only (§3).
    const LIVE_ORDER = [
      'OFFER_ACCEPTED',
      'PRE_START',
      'BLOCKED',
      'READY_TO_START',
      'STARTED',
    ] as const;
    const by_state = LIVE_ORDER.map((state) => ({
      state,
      count: counts.get(state) ?? 0,
    }));
    // §10 invariant — total_live is exactly the sum of the five live states.
    const total_live = by_state.reduce((sum, r) => sum + r.count, 0);

    return {
      total_live,
      by_state,
      start_date: { ...snapshot.start_date, timezone_basis: 'UTC' as const },
      contract_assignments: {
        ...snapshot.contract_assignments,
        coverage: 'forward_materialized' as const,
      },
    };
  }

  // -------------------------------------------------------------------------
  // T7-P4 — guarantee-exposure summary report. Governed by
  // Aramo-T7-P4-Guarantee-Exposure-Reporting-Implementation-Directive-v1_0-LOCKED. Placement
  // owns the aggregate (readGuaranteeExposureSnapshot over the IMMUTABLE PermanentPlacement
  // snapshot + immutable PermanentPlacementRemedy obligation facts — never the mutable P3 term
  // versions, never deriveCommercialMetrics). This service echoes the period, aliases
  // at_risk = active, nests remedy_due, and computes falloff_rate as an integer percent
  // (Math.round(rate*100)) — 0 when the cohort is empty (the T9-B2 rate convention). Summary-
  // only; per-currency money; NO cross-currency total. report:read + tenant/site/A3. Cohort by
  // created_at in [from, to).
  // -------------------------------------------------------------------------
  async getGuaranteeExposure(
    actor: ActorContext,
    period: { from: Date; to: Date },
  ): Promise<GuaranteeExposureReportView> {
    const visibleReqIds = await this.resolveVisibleRequisitionIds(actor);
    const snapshot = await this.guaranteeExposureRepository.readGuaranteeExposureSnapshot({
      tenant_id: actor.tenant_id,
      from: period.from,
      to: period.to,
      ...(visibleReqIds === undefined ? {} : { requisition_ids: visibleReqIds }),
    });

    const falloff_rate =
      snapshot.cohort_count === 0
        ? 0
        : Math.round((snapshot.states.fell_off / snapshot.cohort_count) * 100);

    return {
      period: { from: period.from.toISOString(), to: period.to.toISOString() },
      cohort_count: snapshot.cohort_count,
      // at_risk == active in P4 (§6).
      exposure_by_currency: snapshot.exposure_by_currency.map((r) => ({
        currency: r.currency,
        total: r.total,
        active: r.active,
        satisfied: r.satisfied,
        fell_off: r.fell_off,
        at_risk: r.active,
      })),
      states: {
        active: snapshot.states.active,
        satisfied: snapshot.states.satisfied,
        fell_off: snapshot.states.fell_off,
        remedy_due: {
          replacement: snapshot.states.replacement_due,
          refund: snapshot.states.refund_due,
          prorated_credit: snapshot.states.prorated_credit_due,
        },
        remedy_completed: snapshot.states.remedy_completed,
      },
      remedy_obligation_by_currency: snapshot.remedy_obligation_by_currency.map((r) => ({
        currency: r.currency,
        refund_total: r.refund_total,
        prorated_credit_total: r.prorated_credit_total,
      })),
      falloff_rate,
    };
  }

  // -------------------------------------------------------------------------
  // T9-B4 — margin current-snapshot operational view. Governed by
  // Aramo-T9-B4-Directive-v1_0-LOCKED. Placement OWNS the commercial aggregate +
  // arithmetic (readCurrentMarginSnapshot consumes deriveCommercialMetrics on the
  // Decimal SUM(pay)/SUM(bill) totals — the ONE formula home; §7/§8). This service
  // resolves the A3 visible-requisition set, PULLS the aggregate, and stamps the
  // FORWARD_MATERIALIZED coverage label — NO margin arithmetic here (§29). Aggregate-
  // only, no query params; report:read AND assignment:commercials:read + tenant/site/A3.
  // -------------------------------------------------------------------------
  async getMargin(
    actor: ActorContext,
    requestId: string,
    opts?: { now?: Date },
  ): Promise<MarginReportView> {
    // T9-B5 / AV-1 — explicit site narrows even for see_all principals.
    const visibleReqIds = await this.resolveSiteNarrowedRequisitionIds(actor);
    const snapshot =
      await this.commercialMarginRepository.readCurrentMarginSnapshot({
        tenant_id: actor.tenant_id,
        requestId,
        ...(opts?.now === undefined ? {} : { now: opts.now }),
        ...(visibleReqIds === undefined ? {} : { requisition_ids: visibleReqIds }),
      });
    return {
      eligible_count: snapshot.eligible_count,
      commercialized_count: snapshot.commercialized_count,
      missing_commercial_count: snapshot.missing_commercial_count,
      coverage: 'forward_materialized' as const,
      groups: snapshot.groups,
    };
  }

  // -------------------------------------------------------------------------
  // Per-company metrics — open reqs / placements / submitted / fill-rate for a
  // set of companies (companies list columns + drawer + account-hub KPI strip).
  // Cross-schema id-list compose: visible reqs (in the requested companies) →
  // pipeline counts grouped by requisition → folded up to the company.
  // -------------------------------------------------------------------------
  async getCompanyMetrics(
    actor: ActorContext,
    companyIds: readonly string[],
  ): Promise<CompanyMetricsView[]> {
    const wanted = [...new Set(companyIds)];
    if (wanted.length === 0) return [];
    const wantedSet = new Set(wanted);

    // Visible reqs (the D4b/A3 predicate inside listForActor), narrowed to the
    // requested companies. A generous limit covers a page of companies.
    const reqs = await this.requisitionRepository.listForActor({
      tenant_id: actor.tenant_id,
      visibility: actor.visibility,
      ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      limit: 1000,
    });
    const inScope = reqs.filter((r) => wantedSet.has(r.company_id));

    const reqToCompany = new Map<string, string>();
    const agg = new Map<
      string,
      { open_reqs: number; openings: number; filled: number }
    >();
    for (const r of inScope) {
      reqToCompany.set(r.id, r.company_id);
      const e = agg.get(r.company_id) ?? {
        open_reqs: 0,
        openings: 0,
        filled: 0,
      };
      if (r.status === 'open' || r.status === 'on_hold') e.open_reqs += 1;
      e.openings += r.openings;
      e.filled += Math.max(0, r.openings - r.openings_available);
      agg.set(r.company_id, e);
    }

    const reqIds = inScope.map((r) => r.id);
    // E6 Q-4 — dedupe by (talent, req). Placements use EXISTS(placed) (a placement
    // is a fact); the submitted band uses CURRENT-episode (who is in it now).
    const [placedByReq, submittedByReq] = await Promise.all([
      this.pipelineRepository.countDistinctByRequisition({
        tenant_id: actor.tenant_id,
        requisition_ids: reqIds,
        statuses: ['placed'],
        mode: 'exists',
      }),
      this.pipelineRepository.countDistinctByRequisition({
        tenant_id: actor.tenant_id,
        requisition_ids: reqIds,
        statuses: ['submitted', 'interviewing', 'offered'],
        mode: 'current',
      }),
    ]);
    const foldByCompany = (
      rows: ReadonlyArray<{ requisition_id: string; count: number }>,
    ): Map<string, number> => {
      const m = new Map<string, number>();
      for (const { requisition_id, count } of rows) {
        const co = reqToCompany.get(requisition_id);
        if (co !== undefined) m.set(co, (m.get(co) ?? 0) + count);
      }
      return m;
    };
    const placedPer = foldByCompany(placedByReq);
    const submittedPer = foldByCompany(submittedByReq);

    // Emit a row for EVERY requested company (zeros when it has no visible reqs).
    return wanted.map((company_id) => {
      const e = agg.get(company_id);
      const openings = e?.openings ?? 0;
      const filled = e?.filled ?? 0;
      return {
        company_id,
        open_reqs: e?.open_reqs ?? 0,
        active_placements: placedPer.get(company_id) ?? 0,
        submitted: submittedPer.get(company_id) ?? 0,
        openings,
        filled,
        fill_rate: openings > 0 ? Math.round((filled / openings) * 100) : null,
      };
    });
  }

  // Per-company placements — the placed pipelines at a company's visible reqs
  // (account-hub Placements tab). Cross-schema id-list compose; visibility-scoped.
  async getCompanyPlacements(
    actor: ActorContext,
    companyId: string,
  ): Promise<CompanyPlacementView[]> {
    const reqs = await this.requisitionRepository.listForActor({
      tenant_id: actor.tenant_id,
      visibility: actor.visibility,
      ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      limit: 1000,
    });
    const inScope = reqs.filter((r) => r.company_id === companyId);
    if (inScope.length === 0) return [];
    const titleByReq = new Map(inScope.map((r) => [r.id, r.title]));
    const placed = await this.pipelineRepository.listByRequisitionsAndStatus({
      tenant_id: actor.tenant_id,
      requisition_ids: inScope.map((r) => r.id),
      statuses: ['placed'],
    });
    // E6 Q-4 — one placement per (talent, requisition). listByRequisitionsAndStatus
    // orders by updated_at DESC, so the first row seen for a triple is the latest
    // placed episode; drop any further placed episodes for the same triple.
    const seen = new Set<string>();
    return placed
      .filter((p) => {
        const key = `${p.talent_record_id} ${p.requisition_id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((p) => ({
        pipeline_id: p.id,
        talent_record_id: p.talent_record_id,
        requisition_id: p.requisition_id,
        requisition_title: titleByReq.get(p.requisition_id) ?? 'Requisition',
      }));
  }

  // The tenant goal/target per metric (My Desk goal-progress bars). Reads the
  // `metrics.goals` tenant setting, falling back to its registry default so the
  // bars render for every tenant out-of-box; a tenant overrides via the S2
  // PUT /v1/tenant/settings path (no migration — the settings pattern-B win).
  // Only the keys the FE knows are returned; the value is validated.
  async getRecruiterGoals(
    tenantId: string,
    _userId: string,
  ): Promise<Partial<Record<RecruiterMetricKey, number>>> {
    const KEY = 'metrics.goals' as const;
    let raw: unknown = KNOWN_SETTINGS[KEY].default;
    try {
      const row = await this.tenantSettingRepository.findOne(tenantId, KEY);
      if (row !== null && isMetricGoalMap(row.value)) raw = row.value;
    } catch (err) {
      // A settings read failure must not 500 the whole KPI strip — fall back to
      // the registry default (the FE still renders honest goals).
      this.logger.warn(`metrics.goals read failed; using default: ${String(err)}`);
    }
    if (!isMetricGoalMap(raw)) return {};
    const out: Partial<Record<RecruiterMetricKey, number>> = {};
    for (const key of RECRUITER_METRIC_KEYS) {
      const v = raw[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[key] = v;
    }
    return out;
  }

  // Per-recruiter operational KPIs (My Desk header). Principal-scoped: every
  // metric is computed over the caller's VISIBLE requisitions (the A3/D4b
  // predicate inside listForActor), from pipeline status-history transitions.
  // `now` and `goals` are injected (controller passes the wall clock + the
  // tenant-default targets) so the windowing stays deterministic under test.
  async getRecruiterMetrics(
    actor: ActorContext,
    opts?: {
      now?: Date;
      goals?: Partial<Record<RecruiterMetricKey, number>>;
    },
  ): Promise<RecruiterMetricView[]> {
    const now = opts?.now ?? new Date();
    const goals = opts?.goals ?? {};

    const reqs = await this.requisitionRepository.listForActor({
      tenant_id: actor.tenant_id,
      visibility: actor.visibility,
      ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      limit: 1000,
    });
    const reqIds = reqs.map((r) => r.id);

    const pipelines = await this.pipelineRepository.listForRequisitions({
      tenant_id: actor.tenant_id,
      requisition_ids: reqIds,
    });
    const createdById = new Map<string, Date>(
      pipelines.map((p) => [p.id, p.created_at]),
    );

    // One windowed history read covering the longest series we render.
    const transitions = await this.pipelineRepository.listTransitionsInto({
      tenant_id: actor.tenant_id,
      pipeline_ids: pipelines.map((p) => p.id),
      statuses_to: ['submitted', 'interviewing', 'placed'],
      since: addMonthsUTC(now, -SERIES_MONTHS),
    });
    const submitted = transitions.filter((t) => t.status_to === 'submitted');
    const interviewing = transitions.filter(
      (t) => t.status_to === 'interviewing',
    );
    const placed = transitions.filter((t) => t.status_to === 'placed');

    return [
      {
        key: 'submittals_weekly',
        period: 'week',
        ...weeklyCountMetric(submitted, now, goals.submittals_weekly),
      },
      {
        key: 'interviews_weekly',
        period: 'week',
        ...weeklyCountMetric(interviewing, now, goals.interviews_weekly),
      },
      {
        key: 'placements_monthly',
        period: 'month',
        ...monthlyCountMetric(placed, now, goals.placements_monthly),
      },
      {
        key: 'avg_time_to_submit',
        period: 'week',
        ...weeklyAvgDaysMetric(
          submitted,
          createdById,
          now,
          goals.avg_time_to_submit,
        ),
      },
    ];
  }

  // -------------------------------------------------------------------------
  // Dashboard composition — bundles in-scope metrics into one payload.
  // -------------------------------------------------------------------------

  async getDashboard(actor: ActorContext): Promise<DashboardView> {
    const visibleReqIds = await this.resolveVisibleRequisitionIds(actor);
    const nowIso = new Date().toISOString();
    const [
      tenant_counts,
      requisition_rollup,
      pipeline_rollup,
      placement,
      upcoming_events,
      recent_activity,
    ] = await Promise.all([
      this.getTenantCounts(actor),
      this.getRequisitionRollup(actor),
      // E6 Q-4 — by_status is the CURRENT-episode collapse; total is the distinct-
      // triple sum of those buckets (not a raw row count).
      this.pipelineRepository
        .countByStatus({
          tenant_id: actor.tenant_id,
          ...(visibleReqIds === undefined
            ? {}
            : { requisition_ids: visibleReqIds }),
        })
        .then((by_status) => ({
          total: by_status.reduce((sum, r) => sum + r.count, 0),
          by_status,
        })),
      // E6 Q-4 — distinct (talent, req) with a placed episode EXISTS.
      this.pipelineRepository
        .countDistinctPlaced({
          tenant_id: actor.tenant_id,
          ...(visibleReqIds === undefined
            ? {}
            : { requisition_ids: visibleReqIds }),
        })
        .then((placed_pipelines) => ({
          placed_pipelines,
          includes_core_submittal_placements: false as const,
        })),
      this.calendarRepository.list({
        tenant_id: actor.tenant_id,
        from: nowIso,
        limit: 10,
        ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      }),
      this.activityRepository.list({
        tenant_id: actor.tenant_id,
        limit: 10,
      }),
    ]);
    return {
      tenant_counts,
      requisition_rollup,
      pipeline_rollup,
      placement,
      upcoming_events,
      recent_activity,
    };
  }

  // -------------------------------------------------------------------------
  // The A3 visibility resolver
  // -------------------------------------------------------------------------

  /**
   * Resolves the set of requisition_ids visible to the actor.
   *
   *   - tenant_admin (`requisition:read:all` in scopes) → undefined,
   *     signaling "no filter, tenant-wide".
   *   - recruiter (`requisition:read` only) → an explicit array of the
   *     requisition_ids assigned to AuthContext.sub. Pipeline queries
   *     constrain `requisition_id IN (...)` against this list.
   *
   * Returning undefined for the see-all case is the load-bearing
   * branch: the pipeline repo treats undefined as "no constraint".
   */
  private async resolveVisibleRequisitionIds(
    actor: ActorContext,
  ): Promise<readonly string[] | undefined> {
    if (actor.visibility.see_all_requisition) return undefined;
    const reqs = await this.requisitionRepository.listForActor({
      tenant_id: actor.tenant_id,
      visibility: actor.visibility,
      ...(actor.site_id === undefined ? {} : { site_id: actor.site_id }),
      limit: 200,
    });
    return reqs.map((r) => r.id);
  }

  /**
   * T9-B5 / AV-1 — like {@link resolveVisibleRequisitionIds}, but an EXPLICIT
   * `site_id` narrows the returned set even for tenant-wide (`see_all`)
   * principals. `see_all` grants cross-site visibility; it must NOT silently
   * ignore an explicit site filter (directive §3). Used ONLY by the three
   * site-accepting placement/event reports — fallthrough / assignment-pipeline /
   * margin — so A7 rollups and T7-P4 guarantee-exposure keep their existing
   * shared-resolver behavior unchanged.
   *
   *   - see_all + no `site_id`  → undefined (tenant-wide, preserved);
   *   - see_all + `site_id`     → EVERY requisition id in (tenant, site), resolved
   *     set-based over the existing `requisition.site_id` column (unbounded — the
   *     visibility set does not bound a see_all principal, so `listForActor`'s
   *     200-cap cannot enumerate a site completely);
   *   - non-see_all             → the existing A3 visible-requisition set, which
   *     already threads `site_id` into `listForActor` (unchanged).
   */
  private async resolveSiteNarrowedRequisitionIds(
    actor: ActorContext,
  ): Promise<readonly string[] | undefined> {
    if (actor.visibility.see_all_requisition) {
      if (actor.site_id === undefined) return undefined;
      return this.requisitionRepository.findRequisitionIdsForTenantSite({
        tenant_id: actor.tenant_id,
        site_id: actor.site_id,
      });
    }
    return this.resolveVisibleRequisitionIds(actor);
  }
}
