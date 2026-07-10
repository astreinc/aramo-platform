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
import { normalizeEmail, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { TalentRecordRepository } from '@aramo/talent-record';
import {
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  TalentTrustRepository,
  TalentTrustService,
  type ProposalKind,
  type ProposalStatus,
  type VerificationProposalRow,
} from '@aramo/talent-trust';

import {
  DismissProposalRequestDto,
  MarkActedRequestDto,
} from './dto/verification-proposal.dto.js';

// TR-12 B1/B2 (DDR §4 + B2 §3.1/§3.2) — the caseworker's worklist HTTP surface.
// Lives in apps/api (ABOVE the I15 wall) and calls the cip TalentTrustService;
// talent_trust imports NO ats. The queue LISTS proposals, DISMISSES them, and
// MARKS them ACTED — it can EXECUTE nothing. Every real action is a human click
// into an existing gated endpoint (the FE wires it); this surface only records
// participation. The caseworker's hands stay off the levers by construction.
//
// ACT-TARGET ENRICHMENT (B2 §3.2, Option A ruling): so the FE can one-click a
// VERIFY/RENEW into the existing STORED-SLOT request endpoint, the list resolves,
// SERVER-INTERNALLY, the record pointer (subject → ATS_TALENT_RECORD ref) and — for
// an EMAIL anchor — the email slot (the anchor's normalized_value matched against
// the record's normalized email1/email2 using the SAME normalizer the anchors use,
// byte-equality, no fuzzy match). The anchor VALUE never crosses the wire — only
// the slot NAME + record id ride the response (R10 + PII-lean held). A PHONE anchor,
// an email matching neither slot (record edited since), or an unresolvable ref
// leaves `slot` absent → the FE renders the honest "Open record to verify" deep
// link. record_id/slot are OPTIONAL fields.
//
// GATING (DDR §4): list + dismiss + mark-acted at `talent:read` (capability `ats`,
// the dossier precedent) — the queue disposes/annotates its OWN rows, never the
// ledger. The real ACTs the rows point at carry their own scope (the FE gates the
// button): `talent:edit` (verify/renew) / `identity:resolve` (resolve-contradiction).
interface ProposalListItem {
  id: string;
  tenant_id: string;
  subject_id: string;
  kind: ProposalKind;
  trigger_kind: string;
  basis_ref_id: string;
  basis_kinds: string[];
  status: ProposalStatus;
  created_at: string;
  // Act-target enrichment (optional). record_id = the ATS_TALENT_RECORD the
  // proposal is filed on (the row's pointer link + the deep-link target). slot =
  // the email slot for a one-click VERIFY/RENEW (email anchors with a resolvable
  // slot only). NEVER a value — server-internal matching yields the slot NAME.
  record_id?: string;
  slot?: 'email1' | 'email2';
}

const PROPOSAL_PAGE_DEFAULT_LIMIT = 25;
const PROPOSAL_PAGE_MAX_LIMIT = 100;
const VERIFY_KINDS = new Set<ProposalKind>(['VERIFY_CONTACT', 'RENEW_VERIFICATION']);

function basisKinds(snapshot: unknown): string[] {
  if (snapshot === null || typeof snapshot !== 'object') return [];
  const out: string[] = [];
  for (const v of Object.values(snapshot as Record<string, unknown>)) {
    if (typeof v === 'string') out.push(v);
  }
  return [...new Set(out)];
}

function toBaseItem(row: VerificationProposalRow): ProposalListItem {
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
  constructor(
    private readonly trust: TalentTrustService,
    private readonly repo: TalentTrustRepository,
    private readonly records: TalentRecordRepository,
  ) {}

  // Resolve the record pointer + (for an email VERIFY/RENEW) the email slot,
  // SERVER-INTERNALLY. The anchor's normalized_value is read here only to match a
  // slot; it is never returned. Any unresolvable step simply omits the field →
  // the FE deep-links instead of one-clicking.
  private async enrich(
    tenantId: string,
    row: VerificationProposalRow,
  ): Promise<ProposalListItem> {
    const item = toBaseItem(row);
    const refs = await this.repo.listRefsBySubject(row.subject_id);
    const recordRef = refs.find((r) => r.ref_type === 'ATS_TALENT_RECORD');
    if (recordRef === undefined) return item;
    item.record_id = recordRef.ref_id;

    if (!VERIFY_KINDS.has(row.kind)) return item;
    const anchor = await this.repo.findAnchorById(tenantId, row.basis_ref_id);
    if (anchor === null || anchor.anchor_kind !== 'EMAIL') return item; // PHONE → deep-link
    const record = await this.records.findById({ tenant_id: tenantId, id: recordRef.ref_id });
    if (record === null) return item;
    // Byte-equality on the SAME normalized form the anchors use — no fuzzy match.
    const target = anchor.normalized_value;
    if (record.email1 !== null && normalizeEmail(record.email1) === target) item.slot = 'email1';
    else if (record.email2 !== null && normalizeEmail(record.email2) === target) item.slot = 'email2';
    return item;
  }

  // The worklist. Keyset-paginated, PII-lean, act-target enriched. Default status
  // OPEN; ?status= selects a tab (incl. SETTLED); ?kind= filters. Ordered by
  // created_at only (R10). next_cursor is null on the last page.
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
    const items = await Promise.all(rows.map((r) => this.enrich(authContext.tenant_id, r)));
    return { items, next_cursor: nextCursor };
  }

  // Dismiss a proposal (OPEN-only guard → PROPOSAL_NOT_OPEN 409). Justification
  // required (DTO). Disposes of the proposal ROW only — no ledger effect.
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
    return this.enrich(authContext.tenant_id, row);
  }

  // Mark a proposal ACTED (TR-12 B2 §3.1) — bookkeeping only. The human already
  // fired the real action through its own gated endpoint; this records it (actor =
  // JWT sub, optional note). OPEN-only guard (PROPOSAL_NOT_OPEN 409). Executes
  // nothing — no action endpoint or service is invoked here.
  @Post(':id/act')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('talent:read')
  async act(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: MarkActedRequestDto,
  ): Promise<ProposalListItem> {
    const row = await this.trust.markProposalActed({
      tenant_id: authContext.tenant_id,
      id,
      acted_by: authContext.sub,
      note: body.note ?? null,
      requestId,
    });
    return this.enrich(authContext.tenant_id, row);
  }
}
