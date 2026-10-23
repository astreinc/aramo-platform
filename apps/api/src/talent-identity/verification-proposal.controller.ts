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
  LIFECYCLE_PAGE_DEFAULT_LIMIT,
  LIFECYCLE_PAGE_MAX_LIMIT,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  identifierDigestOf,
  type ProposalKind,
  type ProposalStatus,
  type ProposalView,
} from '@aramo/intelligence-contracts';
import { TalentRecordRepository } from '@aramo/talent-record';

import { DismissProposalRequestDto, MarkActedRequestDto } from './dto/verification-proposal.dto.js';
import { IntelligenceAccess, type IntelligenceStatus } from './intelligence-access.js';

// TR-12 B1/B2 → ATI-SEP-1 T10 WP3b (Addendum A3 T10-2) — the caseworker's
// Trust Proposals worklist, re-pointed onto Talent Intelligence (M-2):
//
//   GET  /v1/talent/identity/proposals             → TI GET  /v1/tenants/:tenant/proposals
//   POST /v1/talent/identity/proposals/:id/dismiss → TI POST /v1/proposals/:id/dismiss
//   POST /v1/talent/identity/proposals/:id/act     → TI POST /v1/proposals/:id/act
//
// The queue LISTS, DISMISSES and MARKS ACTED — it executes nothing (every real
// action is a human click into its own gated endpoint). TI generates the rows.
//
// ACT-TARGET ENRICHMENT (the B2 Option A ruling, kept): record_id = the tenant's
// own ATS record on the proposal's subject; for an EMAIL VERIFY/RENEW the email
// SLOT is matched SERVER-INTERNALLY — TI names the contact by
// sha256(TYPE:normalized_value) only, so the ATS recomputes that digest over the
// record's email1 / email2 with the shared contracts normalizer (byte equality,
// no fuzzy match). Neither the value nor the digest crosses this wire; only the
// slot NAME. PHONE / no matching slot → no slot → the FE deep-links.
//
// FAIL-SOFT: the list answers 200 with no items + intelligence_status when TI is
// not configured / the tenant is not entitled / TI is down. dismiss / act refuse
// with 503 INTELLIGENCE_UNAVAILABLE in that case (nothing to dispose). Gating
// unchanged: talent:read (capability ats); tenant + actor from the JWT only.

export interface ProposalListItem {
  id: string;
  kind: ProposalKind;
  trigger_kind: string;
  status: ProposalStatus;
  /** Named kinds the proposal rests on (an assertion type or an identifier type) — never a value. */
  basis_kinds: string[];
  /** RESOLVE_CONTRADICTION: the contradicted TI assertion. */
  assertion_id?: string;
  /** VERIFY_CONTACT / RENEW_VERIFICATION: EMAIL | PHONE. */
  identifier_type?: 'EMAIL' | 'PHONE';
  created_at: string;
  acted_at?: string;
  action?: string;
  record_id?: string;
  slot?: 'email1' | 'email2';
}

export interface ProposalListResponse {
  intelligence_status: IntelligenceStatus;
  items: ProposalListItem[];
  next_cursor: string | null;
}

const VERIFY_KINDS = new Set<ProposalKind>(['VERIFY_CONTACT', 'RENEW_VERIFICATION']);
const ACT_ACTION: Record<ProposalKind, 'VERIFICATION_REQUESTED' | 'CONTRADICTION_RESOLVED'> = {
  VERIFY_CONTACT: 'VERIFICATION_REQUESTED',
  RENEW_VERIFICATION: 'VERIFICATION_REQUESTED',
  RESOLVE_CONTRADICTION: 'CONTRADICTION_RESOLVED',
};

function toBaseItem(p: ProposalView): ProposalListItem {
  const basis = [p.assertion_type, p.identifier_type].filter((k): k is NonNullable<typeof k> => k !== null);
  return {
    id: p.proposal_id,
    kind: p.kind,
    trigger_kind: p.trigger_kind,
    status: p.status,
    basis_kinds: [...new Set(basis)],
    ...(p.assertion_id !== null ? { assertion_id: p.assertion_id } : {}),
    ...(p.identifier_type !== null ? { identifier_type: p.identifier_type } : {}),
    created_at: p.created_at,
    ...(p.acted_at !== null ? { acted_at: p.acted_at } : {}),
    ...(p.action !== null ? { action: p.action } : {}),
  };
}

@Controller('v1/talent/identity/proposals')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class VerificationProposalController {
  constructor(
    private readonly ti: IntelligenceAccess,
    private readonly records: TalentRecordRepository,
  ) {}

  // Resolve the record pointer + (for an email VERIFY/RENEW) the email slot.
  private async enrich(tenantId: string, p: ProposalView): Promise<ProposalListItem> {
    const item = toBaseItem(p);
    const recordId = p.external_talent_ids[0];
    if (recordId === undefined) return item;
    item.record_id = recordId;
    if (!VERIFY_KINDS.has(p.kind) || p.identifier_type !== 'EMAIL' || p.identifier_digest === null) return item;
    const record = await this.records.findById({ tenant_id: tenantId, id: recordId });
    if (record === null) return item;
    const digest = p.identifier_digest;
    if (record.email1 !== null && record.email1.trim() !== '' && identifierDigestOf('EMAIL', record.email1) === digest) item.slot = 'email1';
    else if (record.email2 !== null && record.email2.trim() !== '' && identifierDigestOf('EMAIL', record.email2) === digest) item.slot = 'email2';
    return item;
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('status') status?: string,
    @Query('kind') kind?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ProposalListResponse> {
    let statusFilter: ProposalStatus = 'OPEN';
    if (status !== undefined && status.length > 0) {
      if (!(PROPOSAL_STATUSES as readonly string[]).includes(status)) throw new BadRequestException(`invalid status: ${status}`);
      statusFilter = status as ProposalStatus;
    }
    let kindFilter: ProposalKind | undefined;
    if (kind !== undefined && kind.length > 0) {
      if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`invalid kind: ${kind}`);
      kindFilter = kind as ProposalKind;
    }
    const parsedLimit = Number.parseInt(limit ?? '', 10);
    const effectiveLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, LIFECYCLE_PAGE_MAX_LIMIT) : LIFECYCLE_PAGE_DEFAULT_LIMIT;
    const tenantId = authContext.tenant_id;
    const page = await this.ti.read(tenantId, (c) =>
      c.listProposals(tenantId, {
        status: statusFilter,
        limit: effectiveLimit,
        ...(kindFilter !== undefined ? { kind: kindFilter } : {}),
        ...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
      }),
    );
    if (page.value === null) return { intelligence_status: page.status, items: [], next_cursor: null };
    const items = await Promise.all(page.value.items.map((p) => this.enrich(tenantId, p)));
    return { intelligence_status: 'ENABLED', items, next_cursor: page.value.next_cursor };
  }

  // Dismiss (OPEN-only in TI → PROPOSAL_NOT_OPEN 409). Justification required.
  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async dismiss(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DismissProposalRequestDto,
  ): Promise<ProposalListItem> {
    const tenantId = authContext.tenant_id;
    const p = await this.ti.act(tenantId, requestId, (c) =>
      c.dismissProposal(id, { tenant_id: tenantId, actor: authContext.sub, justification: body.justification }),
    );
    return this.enrich(tenantId, p);
  }

  // Mark ACTED — bookkeeping only (the human already fired the real action
  // through its own gated endpoint). `action` defaults from the proposal kind
  // when the caller names none (RECORD_UPDATED must be named explicitly).
  @Post(':id/act')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async act(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkActedRequestDto,
  ): Promise<ProposalListItem> {
    const tenantId = authContext.tenant_id;
    const p = await this.ti.act(tenantId, requestId, async (c) => {
      let action = body.action;
      if (action === undefined) {
        // Find the row's kind on the OPEN page (default action per kind).
        const open = await c.listProposals(tenantId, { status: 'OPEN', limit: LIFECYCLE_PAGE_MAX_LIMIT });
        const row = open.items.find((x) => x.proposal_id === id);
        action = row !== undefined ? ACT_ACTION[row.kind] : 'RECORD_UPDATED';
      }
      return c.actOnProposal(id, {
        tenant_id: tenantId,
        actor: authContext.sub,
        action,
        ...(body.note !== undefined && body.note.length > 0 ? { note: body.note } : {}),
      });
    });
    return this.enrich(tenantId, p);
  }
}
