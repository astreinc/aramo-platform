import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  TalentTrustService,
  type ProposalKind,
  type ProposalStatus,
  type VerificationProposalRow,
} from '@aramo/talent-trust';

import { DismissProposalRequestDto } from './dto/verification-proposal.dto.js';

// TR-12 B1 (DDR §4) — the caseworker's worklist HTTP surface. Lives in apps/api
// (ABOVE the I15 wall) and calls the cip TalentTrustService; talent_trust imports
// NO ats. The queue is the recruiter's "what deserves attention next": it LISTS
// proposals and DISMISSES them — it can EXECUTE nothing (no ACT endpoint exists
// this slice; ACT is B2's wiring of the existing gated action endpoints). The
// caseworker's hands stay off the levers by construction (propose-never-dispose).
//
// GATING (DDR §4): the queue reads at `talent:read`, capability `ats` — viewing
// one's trust worklist is reading the records it points at (the dossier
// precedent; no dedicated trust-read scope exists). Dismiss is ALSO `talent:read`:
// it disposes of the proposal ROW only — no ledger effect, no evidence, no merge —
// so it is a curation of the recruiter's own queue, not a privileged trust action.
// The ACTs a proposal points at (B2) each carry their own action scope
// (`talent:edit` for verify/renew, `identity:resolve` for resolve-contradiction).
//
// PII-LEAN (R10): list items carry the kind, the subject/basis pointers (UUIDs),
// the basis KINDS (anchor_kind / assertion_type — never a normalized value), and
// timestamps. NEVER a value, NEVER a number — ordering is created_at, nothing else.
interface ProposalListItem {
  id: string;
  tenant_id: string;
  subject_id: string;
  kind: ProposalKind;
  trigger_kind: string;
  // The triggering row's id (anchor for verify/renew, evidence for contradiction)
  // — a UUID pointer B2's ACT resolves; never a value.
  basis_ref_id: string;
  // The basis snapshot's kinds only (anchor_kind | assertion_type) — never a value.
  basis_kinds: string[];
  status: ProposalStatus;
  created_at: string;
}

// Bounded keyset page size (the advisory-worklist precedent — "bounded default").
const PROPOSAL_PAGE_DEFAULT_LIMIT = 25;
const PROPOSAL_PAGE_MAX_LIMIT = 100;

// Flatten the PII-free basis snapshot ({ anchor_kind } | { assertion_type }) to
// its kind strings. Only string leaves are surfaced — no numbers, no ids.
function basisKinds(snapshot: unknown): string[] {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(snapshot as Record<string, unknown>)) {
    if (typeof v === 'string') out.push(v);
  }
  return [...new Set(out)];
}

function toListItem(row: VerificationProposalRow): ProposalListItem {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    subject_id: row.subject_id,
    kind: row.kind,
    trigger_kind: row.trigger_kind,
    basis_ref_id: row.basis_ref_id,
    basis_kinds: basisKinds(row.basis_snapshot),
    status: row.status,
    created_at: row.created_at.toISOString(),
  };
}

@Controller('v1/talent/identity/proposals')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class VerificationProposalController {
  constructor(private readonly trust: TalentTrustService) {}

  // The worklist. Keyset-paginated (cursor + bounded limit), PII-lean. Default
  // status is OPEN (the queue); ?status= selects a resolved tab; ?kind= filters by
  // proposal kind. `next_cursor` is null on the last page. Ordered by created_at
  // only (R10 — no priority, no ordinal).
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ items: ProposalListItem[]; next_cursor: string | null }> {
    // Default to the OPEN queue; an explicit ?status= selects a tab.
    let statusFilter: ProposalStatus = 'OPEN';
    if (status !== undefined && status.length > 0) {
      if (!(PROPOSAL_STATUSES as readonly string[]).includes(status)) {
        throw new BadRequestException(`invalid status: ${status}`);
      }
      statusFilter = status as ProposalStatus;
    }
    let kindFilter: ProposalKind | undefined;
    if (kind !== undefined && kind.length > 0) {
      if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
        throw new BadRequestException(`invalid kind: ${kind}`);
      }
      kindFilter = kind as ProposalKind;
    }
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    const effectiveLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, PROPOSAL_PAGE_MAX_LIMIT)
        : PROPOSAL_PAGE_DEFAULT_LIMIT;
    const { rows, nextCursor } = await this.trust.listProposals(authContext.tenant_id, {
      status: statusFilter,
      limit: effectiveLimit,
      ...(kindFilter !== undefined ? { kind: kindFilter } : {}),
      ...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
    });
    return { items: rows.map(toListItem), next_cursor: nextCursor };
  }

  // Dismiss a proposal (the OPEN-only guard → PROPOSAL_NOT_OPEN 409 for a terminal
  // row). Justification is required (DTO-enforced). Disposes of the proposal ROW
  // only — no ledger effect (propose-never-dispose).
  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async dismiss(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DismissProposalRequestDto,
  ): Promise<ProposalListItem> {
    const row = await this.trust.dismissProposal({
      tenant_id: authContext.tenant_id,
      id,
      dismissed_by: authContext.sub,
      justification: body.justification,
      requestId,
    });
    return toListItem(row);
  }
}
