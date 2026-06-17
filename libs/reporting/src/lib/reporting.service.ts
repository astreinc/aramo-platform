import { Injectable, Logger } from '@nestjs/common';
import { ActivityRepository } from '@aramo/activity';
import { CalendarRepository } from '@aramo/calendar';
import type { VisibilityContextShape } from '@aramo/common';
import { CompanyRepository } from '@aramo/company';
import { ContactRepository } from '@aramo/contact';
import { PipelineRepository } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';
import { SavedListRepository } from '@aramo/saved-list';
import { TalentRecordRepository } from '@aramo/talent-record';

import type {
  CompanyMetricsView,
  CompanyPlacementView,
  DashboardView,
  PipelineStageRollupView,
  PlacementCountReportView,
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
//     no @aramo/engagement / @aramo/submittal / @aramo/examination /
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
  ) {}

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
    const [total, by_status] = await Promise.all([
      this.pipelineRepository.count({
        tenant_id: actor.tenant_id,
        ...(visibleReqIds === undefined
          ? {}
          : { requisition_ids: visibleReqIds }),
      }),
      this.pipelineRepository.countByStatus({
        tenant_id: actor.tenant_id,
        ...(visibleReqIds === undefined
          ? {}
          : { requisition_ids: visibleReqIds }),
      }),
    ]);
    return { total, by_status };
  }

  async getPlacementCount(
    actor: ActorContext,
  ): Promise<PlacementCountReportView> {
    const visibleReqIds = await this.resolveVisibleRequisitionIds(actor);
    const placed_pipelines = await this.pipelineRepository.count({
      tenant_id: actor.tenant_id,
      status: 'placed',
      ...(visibleReqIds === undefined
        ? {}
        : { requisition_ids: visibleReqIds }),
    });
    return {
      placed_pipelines,
      includes_core_submittal_placements: false,
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
      if (r.status === 'active' || r.status === 'on_hold') e.open_reqs += 1;
      e.openings += r.openings;
      e.filled += Math.max(0, r.openings - r.openings_available);
      agg.set(r.company_id, e);
    }

    const reqIds = inScope.map((r) => r.id);
    const [placedByReq, submittedByReq] = await Promise.all([
      this.pipelineRepository.countByRequisition({
        tenant_id: actor.tenant_id,
        requisition_ids: reqIds,
        statuses: ['placed'],
      }),
      this.pipelineRepository.countByRequisition({
        tenant_id: actor.tenant_id,
        requisition_ids: reqIds,
        statuses: ['submitted', 'interviewing', 'offered'],
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
    return placed.map((p) => ({
      pipeline_id: p.id,
      talent_record_id: p.talent_record_id,
      requisition_id: p.requisition_id,
      requisition_title: titleByReq.get(p.requisition_id) ?? 'Requisition',
    }));
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
      Promise.all([
        this.pipelineRepository.count({
          tenant_id: actor.tenant_id,
          ...(visibleReqIds === undefined
            ? {}
            : { requisition_ids: visibleReqIds }),
        }),
        this.pipelineRepository.countByStatus({
          tenant_id: actor.tenant_id,
          ...(visibleReqIds === undefined
            ? {}
            : { requisition_ids: visibleReqIds }),
        }),
      ]).then(([total, by_status]) => ({ total, by_status })),
      this.pipelineRepository
        .count({
          tenant_id: actor.tenant_id,
          status: 'placed',
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
}
