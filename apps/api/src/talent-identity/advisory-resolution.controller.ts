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
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { SourcedTalentRepository } from '@aramo/sourced-talent';
import {
  DUPLICATE_ADVISORY_STATUSES,
  TalentDuplicateAdvisoryRepository,
  TalentRecordRepository,
  type DuplicateAdvisoryRow,
  type DuplicateAdvisoryStatus,
} from '@aramo/talent-record';

import {
  ApproveMergeRequestDto,
  DismissRequestDto,
  ReverseMergeRequestDto,
} from './dto/advisory-resolution.dto.js';
import { RecordReconcileOrchestrator } from './record-reconcile.orchestrator.js';
import { describeSourcedArrival } from './sourced-arrival.view.js';

// The PRIVILEGED within-tenant duplicate-advisory resolution surface. ATI-SEP-1
// T10 WP2 (Addenda A2 F-1 / A3): rebuilt on the ATS talent_duplicate_advisory
// table — detected from ATS data, resolved by a human; no trust ledger, and no
// Talent Intelligence output gates any action here. Route shapes are unchanged.
//
// Merging two records is NOT recruiter self-serve: every route requires the
// privileged, tenant-scoped `identity:resolve` scope. tenant_id + actor come ONLY
// from the JWT — never a param/body — so cross-tenant resolution is impossible.
//
// Lifecycle: approve (PENDING_REVIEW → APPROVED; a record pair re-homes onto the
// survivor, a sourced arrival links to the record) / dismiss (→ DISMISSED) /
// reverse (APPROVED → REVERSED; undoes the re-home / the link). GET lists the
// reviewer queue. Wire divergence (documented): the trust-only fields (advise
// band, contradiction flags, confirmed/contradiction/conflict kinds, reopen
// provenance, subject ids) are gone; the pair is named by record ids.

export interface AdvisoryListItem {
  id: string;
  tenant_id: string;
  talent_record_a_id: string;
  talent_record_a_name: string | null;
  talent_record_b_id: string | null;
  talent_record_b_name: string | null;
  sourced_talent_id: string | null;
  sourced_talent_name: string | null;
  basis: string;
  status: DuplicateAdvisoryStatus;
  created_at: string;
  shared_anchor_kinds: string[];
}

export interface AdvisoryView {
  id: string;
  tenant_id: string;
  talent_record_a_id: string;
  talent_record_b_id: string | null;
  sourced_talent_id: string | null;
  basis: string;
  shared_anchor_kinds: string[];
  status: DuplicateAdvisoryStatus;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  justification: string | null;
  surviving_record_id: string | null;
  superseded_record_id: string | null;
  merge_completed_at: string | null;
  reversed_by: string | null;
  reversed_at: string | null;
  reversal_justification: string | null;
  // Present on a reverse: rows added to the survivor after the re-home, listed
  // for human triage (never moved automatically).
  post_merge_accretions?: Array<{ domain: string; ids: string[] }>;
}

const ADVISORY_PAGE_DEFAULT_LIMIT = 25;
const ADVISORY_PAGE_MAX_LIMIT = 100;

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

function toView(row: DuplicateAdvisoryRow): AdvisoryView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    talent_record_a_id: row.talent_record_a_id,
    talent_record_b_id: row.talent_record_b_id,
    sourced_talent_id: row.sourced_talent_id,
    basis: row.basis,
    shared_anchor_kinds: [...row.shared_kinds],
    status: row.status,
    created_at: row.created_at.toISOString(),
    decided_by: row.decided_by,
    decided_at: iso(row.decided_at),
    justification: row.justification,
    surviving_record_id: row.surviving_record_id,
    superseded_record_id: row.superseded_record_id,
    merge_completed_at: iso(row.merge_completed_at),
    reversed_by: row.reversed_by,
    reversed_at: iso(row.reversed_at),
    reversal_justification: row.reversal_justification,
  };
}

@Controller('v1/talent/identity/advisories')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class AdvisoryResolutionController {
  constructor(
    private readonly advisories: TalentDuplicateAdvisoryRepository,
    private readonly talentRecords: TalentRecordRepository,
    private readonly sourced: SourcedTalentRepository,
    private readonly reconcile: RecordReconcileOrchestrator,
  ) {}

  // The reviewer worklist — keyset-paginated, default PENDING_REVIEW.
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: AdvisoryListItem[]; next_cursor: string | null }> {
    let statusFilter: DuplicateAdvisoryStatus = 'PENDING_REVIEW';
    if (status !== undefined && status.length > 0) {
      if (!(DUPLICATE_ADVISORY_STATUSES as readonly string[]).includes(status)) {
        throw new BadRequestException(`invalid status: ${status}`);
      }
      statusFilter = status as DuplicateAdvisoryStatus;
    }
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    const effectiveLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, ADVISORY_PAGE_MAX_LIMIT)
        : ADVISORY_PAGE_DEFAULT_LIMIT;
    const tenant_id = authContext.tenant_id;
    const { rows, nextCursor } = await this.advisories.listKeyset({
      tenant_id,
      status: statusFilter,
      limit: effectiveLimit,
      ...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
    });

    const recordIds = rows.flatMap((r) =>
      r.talent_record_b_id === null ? [r.talent_record_a_id] : [r.talent_record_a_id, r.talent_record_b_id],
    );
    const names = await this.talentRecords.findNamesByIds({ tenant_id, ids: recordIds });
    const arrivalIds = rows.flatMap((r) => (r.sourced_talent_id === null ? [] : [r.sourced_talent_id]));
    const arrivals = await this.sourced.findByIds(tenant_id, arrivalIds);
    const arrivalNames = new Map(arrivals.map((a) => [a.id, describeSourcedArrival(a).display_name]));

    return {
      items: rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        talent_record_a_id: r.talent_record_a_id,
        talent_record_a_name: names.get(r.talent_record_a_id) ?? null,
        talent_record_b_id: r.talent_record_b_id,
        talent_record_b_name:
          r.talent_record_b_id === null ? null : (names.get(r.talent_record_b_id) ?? null),
        sourced_talent_id: r.sourced_talent_id,
        sourced_talent_name:
          r.sourced_talent_id === null ? null : (arrivalNames.get(r.sourced_talent_id) ?? null),
        basis: r.basis,
        status: r.status,
        created_at: r.created_at.toISOString(),
        shared_anchor_kinds: [...r.shared_kinds],
      })),
      next_cursor: nextCursor,
    };
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
    const tenant_id = authContext.tenant_id;
    const row = await this.mustFind(tenant_id, id, requestId);

    // Resume a re-home a crash left incomplete (approve is the resume entry).
    if (row.status === 'APPROVED' && row.talent_record_b_id !== null && row.merge_completed_at === null) {
      return toView(await this.reconcile.reconcile({ tenant_id, advisory: row, actor_id: authContext.sub }));
    }
    if (row.status !== 'PENDING_REVIEW') throw notPending(id, row.status, requestId);

    const decided = {
      decided_by: authContext.sub,
      decided_at: new Date(),
      justification: body.justification ?? null,
    };

    // A sourced arrival → link it to the existing record (same human).
    if (row.sourced_talent_id !== null) {
      const approved = await this.advisories.transition({
        tenant_id,
        id,
        from: ['PENDING_REVIEW'],
        data: { status: 'APPROVED', ...decided, surviving_record_id: row.talent_record_a_id },
      });
      if (approved === null) throw notPending(id, row.status, requestId);
      await this.advisories.linkArrivalByAdvisory({
        tenant_id,
        sourced_talent_id: row.sourced_talent_id,
        talent_record_id: row.talent_record_a_id,
        advisory_id: row.id,
        linked_by: authContext.sub,
      });
      return toView(approved);
    }

    // A record pair → re-home the other record onto the survivor.
    const recordB = row.talent_record_b_id as string;
    const surviving = body.surviving_record_id ?? row.talent_record_a_id;
    if (surviving !== row.talent_record_a_id && surviving !== recordB) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'surviving_record_id must be one of the advisory pair',
        400,
        { requestId, details: { field: 'surviving_record_id' } },
      );
    }
    const superseded = surviving === row.talent_record_a_id ? recordB : row.talent_record_a_id;
    await this.reconcile.preflight({
      tenant_id,
      surviving_record_id: surviving,
      superseded_record_id: superseded,
      requestId,
    });
    const approved = await this.advisories.transition({
      tenant_id,
      id,
      from: ['PENDING_REVIEW'],
      data: {
        status: 'APPROVED',
        ...decided,
        surviving_record_id: surviving,
        superseded_record_id: superseded,
        merge_state: { sweep_steps: [], collision_records: [] },
      },
    });
    if (approved === null) throw notPending(id, row.status, requestId);
    return toView(await this.reconcile.reconcile({ tenant_id, advisory: approved, actor_id: authContext.sub }));
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
    const row = await this.mustFind(authContext.tenant_id, id, requestId);
    const dismissed = await this.advisories.transition({
      tenant_id: authContext.tenant_id,
      id,
      from: ['PENDING_REVIEW'],
      data: {
        status: 'DISMISSED',
        decided_by: authContext.sub,
        decided_at: new Date(),
        justification: body.justification ?? null,
      },
    });
    if (dismissed === null) throw notPending(id, row.status, requestId);
    return toView(dismissed);
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
    const tenant_id = authContext.tenant_id;
    const row = await this.mustFind(tenant_id, id, requestId);
    if (row.status !== 'APPROVED') {
      throw new AramoError('ADVISORY_NOT_MERGED', 'Only an approved advisory can be reversed', 409, {
        requestId,
        details: { advisory_id: id, status: row.status },
      });
    }
    const justification = (body.justification ?? '').trim();
    if (justification === '') {
      throw new AramoError(
        'REVERSAL_JUSTIFICATION_REQUIRED',
        'A justification is required to reverse an approval',
        400,
        { requestId, details: { advisory_id: id } },
      );
    }

    let accretions: Array<{ domain: string; ids: string[] }> = [];
    if (row.sourced_talent_id !== null) {
      await this.advisories.unlinkArrivalByAdvisory({
        tenant_id,
        sourced_talent_id: row.sourced_talent_id,
        advisory_id: row.id,
      });
    } else if (row.merge_state !== null) {
      accretions = await this.reconcile.reverse({ tenant_id, advisory: row, actor_id: authContext.sub });
    }

    const reversed = await this.advisories.transition({
      tenant_id,
      id,
      from: ['APPROVED'],
      data: {
        status: 'REVERSED',
        reversed_by: authContext.sub,
        reversed_at: new Date(),
        reversal_justification: justification,
        ...(row.merge_state !== null
          ? { merge_state: { ...row.merge_state, post_merge_accretions: accretions } }
          : {}),
      },
    });
    if (reversed === null) {
      throw new AramoError('ADVISORY_NOT_MERGED', 'Only an approved advisory can be reversed', 409, {
        requestId,
        details: { advisory_id: id },
      });
    }
    return { ...toView(reversed), post_merge_accretions: accretions };
  }

  private async mustFind(tenant_id: string, id: string, requestId: string): Promise<DuplicateAdvisoryRow> {
    const row = UUID_RE.test(id) ? await this.advisories.findById(tenant_id, id) : null;
    if (row === null) {
      throw new AramoError('NOT_FOUND', 'Advisory not found', 404, {
        requestId,
        details: { advisory_id: id },
      });
    }
    return row;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notPending(id: string, status: string, requestId: string): AramoError {
  return new AramoError('ADVISORY_NOT_PENDING', 'This advisory has already been resolved', 409, {
    requestId,
    details: { advisory_id: id, status },
  });
}
