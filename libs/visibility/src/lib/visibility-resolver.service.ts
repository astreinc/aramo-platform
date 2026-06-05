import { Injectable } from '@nestjs/common';
import type { AuthContextType } from '@aramo/auth';
import {
  ManagementEdgeRepository,
  TeamRepository,
} from '@aramo/identity';
import {
  TeamClientOwnershipRepository,
  UserClientAssignmentRepository,
} from '@aramo/company';
import { RequisitionRepository } from '@aramo/requisition';
import { PipelineRepository } from '@aramo/pipeline';

import {
  MAX_MANAGEMENT_DEPTH,
  SCOPE_COMPANY_READ_ALL,
  SCOPE_REQUISITION_READ_ALL,
} from './constants.js';
import type { VisibilityContext } from './visibility-context.js';

// AUTHZ-D4b — VisibilityResolverService.
//
// THE READ-SIDE owner. Computes `visible_client_ids` per Amendment v1.1
// §4.3 (the composed predicate: direct ∪ transitive-reports[depth≤3] ∪
// pod-clients ∪ [ALL if company:read:all]) and the derived sets
// `visible_requisition_ids` + `visible_pipeline_ids` consumed by the
// pipeline / submittal / activity cascade per the D4b directive §3.
//
// Cycle-avoidance (Gate-5 Ruling 1): this lib is the ONLY home for the
// cross-schema visibility reads — the 6 entity libs receive the resolved
// VisibilityContext as a parameter (NOT an import). The dependency graph
// is `visibility → {identity, company, requisition, pipeline}`; none of
// those import `@aramo/visibility` (the directional discipline).
//
// Per-request memoization: VisibilityInterceptor caches the resolved
// context (and the derived sets) on the Express request object — the
// service is stateless; the lifetime owner is the request.
//
// All reads are tenant-scoped.
@Injectable()
export class VisibilityResolverService {
  constructor(
    private readonly assignments: UserClientAssignmentRepository,
    private readonly ownerships: TeamClientOwnershipRepository,
    private readonly edges: ManagementEdgeRepository,
    private readonly teams: TeamRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly pipelines: PipelineRepository,
  ) {}

  // -------------------------------------------------------------------------
  // The base predicate (Amendment §4.3) — the union the cascade consumes.
  // -------------------------------------------------------------------------

  async resolveForActor(authContext: AuthContextType): Promise<VisibilityContext> {
    const tenant_id = authContext.tenant_id;
    const actor_user_id = authContext.sub;
    const scopes = new Set(authContext.scopes);
    const see_all_company = scopes.has(SCOPE_COMPANY_READ_ALL);
    const see_all_requisition = scopes.has(SCOPE_REQUISITION_READ_ALL);

    if (see_all_company) {
      // The see-all short-circuit (TA + TO only per D4a §6 ruling).
      // visible_client_ids is null — entity filters skip the IN-clause
      // and return all tenant rows.
      return {
        tenant_id,
        actor_user_id,
        see_all_company,
        see_all_requisition,
        visible_client_ids: null,
      };
    }

    // The 3 families (per Amendment §4.3 + the D4b directive §1).
    //
    // (1) Direct (Axis-0).
    const directIds = await this.assignments.findCompanyIdsForUser({
      tenant_id,
      user_id: actor_user_id,
    });

    // (2) Axis-1 — transitive reports' direct assignments (depth ≤ 3).
    const reportUserIds = await this.edges.findTransitiveReportUserIds({
      tenant_id,
      manager_user_id: actor_user_id,
      max_depth: MAX_MANAGEMENT_DEPTH,
    });
    const reportIds = await this.assignments.findCompanyIdsForUsers({
      tenant_id,
      user_ids: Array.from(reportUserIds),
    });

    // (3) Axis-2 — pod-clients (active teams).
    const teamIds = await this.teams.findActiveTeamIdsForUser({
      tenant_id,
      user_id: actor_user_id,
    });
    const podIds = await this.ownerships.findCompanyIdsForTeams({
      tenant_id,
      team_ids: teamIds,
    });

    const union = new Set<string>();
    for (const id of directIds) union.add(id);
    for (const id of reportIds) union.add(id);
    for (const id of podIds) union.add(id);

    return {
      tenant_id,
      actor_user_id,
      see_all_company,
      see_all_requisition,
      visible_client_ids: union,
    };
  }

  // -------------------------------------------------------------------------
  // Derived set: visible_requisition_ids — consumed by pipeline / submittal
  // (transitive via requisition_id / job_id) and by activity (the polymorphic
  // OR's requisition branch).
  //
  // Applies the §4 A3 OR-union directly: a recruiter sees a req whose
  // company is in visible_client_ids OR which they're directly assigned to.
  // -------------------------------------------------------------------------

  async resolveVisibleRequisitionIds(
    ctx: VisibilityContext,
  ): Promise<ReadonlySet<string> | null> {
    if (ctx.see_all_requisition) return null; // no filter
    const ids = await this.requisitions.findVisibleRequisitionIds({
      tenant_id: ctx.tenant_id,
      actor_user_id: ctx.actor_user_id,
      visible_client_ids: ctx.visible_client_ids,
    });
    return new Set(ids);
  }

  // -------------------------------------------------------------------------
  // Derived set: visible_pipeline_ids — consumed ONLY by activity (the
  // polymorphic OR's pipeline branch). Each pipeline inherits its
  // requisition's visibility.
  //
  // Implemented as a single Prisma query (pipeline WHERE requisition_id IN
  // visibleReqIds) — no fetch-then-filter (D6 query-layer).
  // -------------------------------------------------------------------------

  async resolveVisiblePipelineIds(
    ctx: VisibilityContext,
  ): Promise<ReadonlySet<string> | null> {
    if (ctx.see_all_requisition && ctx.see_all_company) {
      // both see-alls → activity sees all pipeline rows; null skips the IN.
      return null;
    }
    const visibleReqIds = await this.resolveVisibleRequisitionIds(ctx);
    if (visibleReqIds === null) {
      // requisition:read:all → all reqs visible → all pipelines visible.
      return null;
    }
    const ids = await this.pipelines.findIdsForRequisitions({
      tenant_id: ctx.tenant_id,
      requisition_ids: Array.from(visibleReqIds),
    });
    return new Set(ids);
  }
}
