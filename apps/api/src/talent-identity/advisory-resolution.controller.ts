import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  MATCH_ADVISORY_STATUSES,
  SubjectResolutionService,
  TalentTrustRepository,
  type MatchAdvisoryStatus,
  type SubjectMatchAdvisoryRow,
} from '@aramo/talent-trust';

import {
  ApproveMergeRequestDto,
  DismissRequestDto,
  ReverseMergeRequestDto,
} from './dto/advisory-resolution.dto.js';
import { RecordReconcileOrchestrator } from './record-reconcile.orchestrator.js';

// TR-2a-3 — the PRIVILEGED advisory-resolution HTTP surface. Lives in apps/api
// (ABOVE the I15 wall) and calls the cip talent_trust resolution service —
// talent_trust imports NO ats; this composition-root controller is the only place
// the HTTP edge meets the cip merge action.
//
// Merging two humans is NOT recruiter self-serve (R6): every route requires the
// privileged, tenant-scoped `identity:resolve` scope (tenant_admin + tenant_owner).
// tenant_id + actor come ONLY from the JWT (authContext) — never a param/body — so
// cross-tenant resolution is impossible and the audit actor is authentic (R4).
//
// Actions (R5 lifecycle): approve (→ MERGED, pointer-only merge) / dismiss (→
// DISMISSED) / reverse (→ REVERSED, un-merge). A contradicted advisory needs an
// explicit ack + justification to approve (R3). GET lists the reviewer queue.

// The advisory as returned to the reviewer — every field is PII-free (subject +
// anchor-row refs + kinds only; match_basis never carries a normalized_value).
interface AdvisoryView {
  id: string;
  tenant_id: string;
  subject_a_id: string;
  subject_b_id: string;
  advise_band: string;
  has_contradiction: boolean;
  match_basis: unknown;
  status: MatchAdvisoryStatus;
  created_at: string;
  resolution_action: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_justification: string | null;
  surviving_subject_id: string | null;
  merged_subject_id: string | null;
  reversed_by: string | null;
  reversed_at: string | null;
  reversal_justification: string | null;
}

function toView(row: SubjectMatchAdvisoryRow): AdvisoryView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subject_a_id: row.subject_a_id,
    subject_b_id: row.subject_b_id,
    advise_band: row.advise_band,
    has_contradiction: row.has_contradiction,
    match_basis: row.match_basis,
    status: row.status,
    created_at: row.created_at.toISOString(),
    resolution_action: row.resolution_action,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at ? row.resolved_at.toISOString() : null,
    resolution_justification: row.resolution_justification,
    surviving_subject_id: row.surviving_subject_id,
    merged_subject_id: row.merged_subject_id,
    reversed_by: row.reversed_by,
    reversed_at: row.reversed_at ? row.reversed_at.toISOString() : null,
    reversal_justification: row.reversal_justification,
  };
}

@Controller('v1/talent/identity/advisories')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class AdvisoryResolutionController {
  constructor(
    private readonly resolution: SubjectResolutionService,
    private readonly repo: TalentTrustRepository,
    // TR-2a-B3b (DDR-3 §1) — phase 2 (the record reconcile) is delegated to the
    // boundary orchestrator; this controller is the advisory-resolution entry point
    // that sequences phase 1 (the cip subject merge) then phase 2.
    private readonly reconcile: RecordReconcileOrchestrator,
  ) {}

  // The reviewer queue. Optional ?status= filter (defaults to all for the tenant).
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('status') status?: string,
  ): Promise<{ items: AdvisoryView[] }> {
    let statusFilter: MatchAdvisoryStatus | undefined;
    if (status !== undefined && status.length > 0) {
      if (!(MATCH_ADVISORY_STATUSES as readonly string[]).includes(status)) {
        throw new BadRequestException(`invalid status: ${status}`);
      }
      statusFilter = status as MatchAdvisoryStatus;
    }
    const rows = await this.repo.listMatchAdvisories(authContext.tenant_id, {
      ...(statusFilter ? { status: statusFilter } : {}),
    });
    return { items: rows.map(toView) };
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async approve(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: ApproveMergeRequestDto,
  ): Promise<AdvisoryView> {
    const row = await this.resolution.approveMerge({
      tenant_id: authContext.tenant_id,
      advisory_id: id,
      actor: authContext.sub,
      ...(body.surviving_subject_id ? { surviving_subject_id: body.surviving_subject_id } : {}),
      ...(body.justification !== undefined ? { justification: body.justification } : {}),
      ...(body.override_acknowledged !== undefined
        ? { override_acknowledged: body.override_acknowledged }
        : {}),
    });

    // Phase 2 — the record reconcile (DDR-3 §1/§2). Runs synchronously after the
    // subject merge; the orchestrator determines the case (neither/one/both
    // promoted), normalizes refs, sweeps holders, and recomputes. Durably
    // checkpointed → a crash leaves a resumable PENDING operation (resume command).
    if (row.surviving_subject_id !== null && row.merged_subject_id !== null) {
      await this.reconcile.reconcile({
        tenant_id: authContext.tenant_id,
        advisory_id: row.id,
        surviving_subject_id: row.surviving_subject_id,
        merged_subject_id: row.merged_subject_id,
        actor_id: authContext.sub,
      });
    }
    return toView(row);
  }

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async dismiss(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: DismissRequestDto,
  ): Promise<AdvisoryView> {
    const row = await this.resolution.dismiss({
      tenant_id: authContext.tenant_id,
      advisory_id: id,
      actor: authContext.sub,
      ...(body.justification !== undefined ? { justification: body.justification } : {}),
    });
    return toView(row);
  }

  @Post(':id/reverse')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async reverse(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: ReverseMergeRequestDto,
  ): Promise<AdvisoryView> {
    // Capture the merge direction BEFORE reverseMerge (the advisory keeps its
    // surviving/merged ids, but read it up front for the operation lookup).
    const before = await this.repo.findMatchAdvisoryById(authContext.tenant_id, id);
    // Phase 1 — un-merge the subject pointer + advisory → REVERSED.
    const row = await this.resolution.reverseMerge({
      tenant_id: authContext.tenant_id,
      advisory_id: id,
      actor: authContext.sub,
      justification: body.justification,
    });
    // Phase 2 — reverse the record reconcile if a COMPLETED operation exists
    // (DDR-3 §6): lift supersession, restore ref topology, re-point back exactly the
    // recorded rows, re-create collision rows, recompute both subjects. Pre-B3b
    // merges (no operation) reverse as phase 1 only.
    if (before?.surviving_subject_id != null && before?.merged_subject_id != null) {
      const op = await this.repo.findMergeOperationBySubjects(
        authContext.tenant_id,
        before.surviving_subject_id,
        before.merged_subject_id,
      );
      if (op?.status === 'COMPLETED') {
        await this.reconcile.reverse({
          tenant_id: authContext.tenant_id,
          operation_id: op.id,
          actor_id: authContext.sub,
          justification: body.justification,
        });
      }
    }
    return toView(row);
  }
}
