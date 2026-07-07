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
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  MATCH_ADVISORY_STATUSES,
  SubjectResolutionService,
  TalentTrustRepository,
  type MatchAdvisoryStatus,
  type MatchBasis,
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

// TR-6 B2 (DDR D5) — the enriched reviewer-worklist LIST item. PII-lean: bands +
// named KINDS only, NEVER a normalized_value and NEVER a numeric ordering signal (R10 — bands only). The
// kinds are flattened out of match_basis so the FE renders them as named chips
// without parsing the basis blob. Reopen provenance is surfaced for the marker.
interface AdvisoryListItem {
  id: string;
  tenant_id: string;
  subject_a_id: string;
  subject_b_id: string;
  advise_band: string;
  has_contradiction: boolean;
  status: MatchAdvisoryStatus;
  created_at: string;
  confirmed_kinds: string[];
  contradiction_kinds: string[];
  corroborator_conflict_kinds: string[];
  // Distinct anchor KINDS shared by the pair (from match_basis.shared) — kinds only,
  // never the anchor-row ids and never the normalized value.
  shared_anchor_kinds: string[];
  reopened_at: string | null;
  reopened_from_band: string | null;
}

// Bounded keyset page size (DDR D5 — "bounded default"). A reviewer scans a page,
// pages via next_cursor; the cap keeps the response PII-lean and the query cheap.
const ADVISORY_PAGE_DEFAULT_LIMIT = 25;
const ADVISORY_PAGE_MAX_LIMIT = 100;

function uniqueKinds(kinds: readonly string[] | undefined): string[] {
  return kinds === undefined ? [] : [...new Set(kinds)];
}

function toListItem(row: SubjectMatchAdvisoryRow): AdvisoryListItem {
  // match_basis is the PII-free MatchBasis blob (kinds + anchor-row ids only).
  const basis = (row.match_basis ?? {}) as Partial<MatchBasis>;
  const sharedKinds = uniqueKinds((basis.shared ?? []).map((s) => s.anchor_kind));
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subject_a_id: row.subject_a_id,
    subject_b_id: row.subject_b_id,
    advise_band: row.advise_band,
    has_contradiction: row.has_contradiction,
    status: row.status,
    created_at: row.created_at.toISOString(),
    confirmed_kinds: uniqueKinds(basis.confirmed_kinds),
    contradiction_kinds: uniqueKinds(basis.contradiction_kinds),
    corroborator_conflict_kinds: uniqueKinds(basis.corroborator_conflict_kinds),
    shared_anchor_kinds: sharedKinds,
    reopened_at: row.reopened_at ? row.reopened_at.toISOString() : null,
    reopened_from_band: row.reopened_from_band,
  };
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

  // TR-6 B2 (DDR D5) — the reviewer worklist. Keyset-paginated (cursor + bounded
  // limit), enriched (bands + named kinds, never values or numeric signals). Default status is
  // PENDING_REVIEW (the reviewer queue); the ?status= filter is retained for the
  // resolved tabs. `next_cursor` is null on the last page.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: AdvisoryListItem[]; next_cursor: string | null }> {
    // Default to the PENDING_REVIEW queue; an explicit ?status= selects a tab.
    let statusFilter: MatchAdvisoryStatus = 'PENDING_REVIEW';
    if (status !== undefined && status.length > 0) {
      if (!(MATCH_ADVISORY_STATUSES as readonly string[]).includes(status)) {
        throw new BadRequestException(`invalid status: ${status}`);
      }
      statusFilter = status as MatchAdvisoryStatus;
    }
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    const effectiveLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, ADVISORY_PAGE_MAX_LIMIT)
        : ADVISORY_PAGE_DEFAULT_LIMIT;
    const { rows, nextCursor } = await this.repo.listMatchAdvisoriesKeyset(
      authContext.tenant_id,
      {
        status: statusFilter,
        limit: effectiveLimit,
        ...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
      },
    );
    return { items: rows.map(toListItem), next_cursor: nextCursor };
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async approve(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: ApproveMergeRequestDto,
  ): Promise<AdvisoryView> {
    const row = await this.resolution.approveMerge({
      tenant_id: authContext.tenant_id,
      advisory_id: id,
      actor: authContext.sub,
      requestId,
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
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: DismissRequestDto,
  ): Promise<AdvisoryView> {
    const row = await this.resolution.dismiss({
      tenant_id: authContext.tenant_id,
      advisory_id: id,
      actor: authContext.sub,
      requestId,
      ...(body.justification !== undefined ? { justification: body.justification } : {}),
    });
    return toView(row);
  }

  @Post(':id/reverse')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async reverse(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
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
      requestId,
      // Empty/missing → the service refuses with REVERSAL_JUSTIFICATION_REQUIRED (R4).
      justification: body.justification ?? '',
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
          // Phase 1 (reverseMerge) already refused an empty justification, so this is
          // the validated non-empty string; the `?? ''` only satisfies the optional DTO type.
          justification: body.justification ?? '',
        });
      }
    }
    return toView(row);
  }
}
