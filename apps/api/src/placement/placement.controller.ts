import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  PlacementRepository,
  PlacementProcessEventRepository,
  edgeAuthorityClass,
  type PlacementProcessEventView,
  type PlacementProcessView,
  type PlacementState,
} from '@aramo/placement';

import { CreatePlacementDto, TransitionPlacementDto } from './dto/placement.dto.js';

// Track 3 / E1-b + E1-d — the guarded PlacementProcess HTTP surface. ONE generic
// transition route (§1): the target is in the body and the canonical 14-edge
// matrix (DB-trigger-enforced) owns legality — no named outcome routes.
// Authorization (§2) uses dedicated placement:* scopes; the transition route
// requires the placement:<class> scope DERIVED from the target edge under the
// ratified classification (data-dependent, so it is enforced here where the
// from/to pair is known, not as a static route scope). Placement scopes are
// granted by the #577 role matrix (recruiter: read/create/transition; AM/admin:
// + activate/terminate).
//
// E1-d / D-3 — the guard chain is aligned to the requisition/pipeline house
// pattern (the intended ATS placement boundary):
//   @RequireCapability('ats')   — tenant axis (was 'core', an E1-b mislabel;
//                                  placement is an ATS recruiting entity beside
//                                  requisition/pipeline, which both require 'ats')
//   @RequireScopes('placement:read')  — scope axis (read routes)
//   @RequireSiteMatch()               — site axis (read routes)
// Read routes additionally apply the actor-visibility predicate in the
// repository (findByIdForActor / listForActor): a placement whose requisition is
// not in the actor's visible set is 404 (never 403 — the scope passed).
@Controller('v1/placements')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class PlacementController {
  constructor(
    private readonly placements: PlacementRepository,
    private readonly events: PlacementProcessEventRepository,
  ) {}

  // E1-d / Scope A — the placement collection read. Tenant-isolated and
  // actor-visibility-scoped; optional narrowing by the indexed axes
  // (requisition_id / submittal_id / talent_record_id). Envelope { items }
  // (house pattern). The projection carries NO reason evidence (D-1/D-2).
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() auth: AuthContextType,
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('submittal_id') submittalId: string | undefined,
    @Query('talent_record_id') talentRecordId: string | undefined,
    @Req() req: Request,
  ): Promise<{ items: PlacementProcessView[] }> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const items = await this.placements.listForActor({
      tenant_id: auth.tenant_id,
      visible_requisition_ids: visibleReqIds,
      ...(requisitionId === undefined ? {} : { requisition_id: requisitionId }),
      ...(submittalId === undefined ? {} : { submittal_id: submittalId }),
      ...(talentRecordId === undefined ? {} : { talent_record_id: talentRecordId }),
    });
    return { items };
  }

  // Create on the explicit client-selection/offer fact (initial state
  // OFFER_EXTENDED). Duplicate live attempt → PLACEMENT_ALREADY_LIVE (409).
  //
  // E4 — replacement is a CONJUNCTION, evaluated at this one point. The route
  // always requires placement:create (the static guard above). When
  // replaces_placement_process_id is PRESENT the request ALSO requires
  // placement:replace — checked imperatively here (data-dependent, like the
  // transition edge scope), NEVER a fallback where holding either passes. This is
  // what stops placement:replace becoming an alternative general creation
  // permission (§3). A create-only principal with the field present is refused
  // 403 here BEFORE any mutation; the eligibility validation (422) runs later in
  // the repository, so authorization strictly precedes linkage validation.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('placement:create')
  async create(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Body() body: CreatePlacementDto,
  ) {
    if (body.replaces_placement_process_id != null && !auth.scopes.includes('placement:replace')) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'a replacement placement requires the placement:replace scope', 403, {
        requestId,
        details: { required_scope: 'placement:replace', replaces_placement_process_id: body.replaces_placement_process_id },
      });
    }
    return this.placements.createPlacement(
      {
        tenant_id: auth.tenant_id,
        submittal_id: body.submittal_id,
        requisition_id: body.requisition_id,
        talent_record_id: body.talent_record_id,
        // E1-c offer snapshot — the DTO carries ISO strings (IsDateString); the
        // repository I/O type is Date-typed, so convert at the HTTP boundary.
        offered_at: body.offered_at != null ? new Date(body.offered_at) : undefined,
        proposed_start_date: body.proposed_start_date != null ? new Date(body.proposed_start_date) : undefined,
        offer_expires_at: body.offer_expires_at != null ? new Date(body.offer_expires_at) : undefined,
        client_offer_reference: body.client_offer_reference,
        offer_terms_summary: body.offer_terms_summary,
        // E4 — replacement lineage; the repository validates and persists it (§5).
        replaces_placement_process_id: body.replaces_placement_process_id,
      },
      requestId,
    );
  }

  // Generic governed transition. The required scope is DATA-dependent on the edge:
  // ordinary progression → placement:transition, live/capacity → placement:activate,
  // terminal → placement:terminate. Checked here (before the state change); the
  // 14-edge matrix then enforces legality (PLACEMENT_STATE_INVALID, 422).
  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  async transition(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: TransitionPlacementDto,
  ) {
    const current = await this.placements.findById(auth.tenant_id, id);
    if (current === null) {
      throw new AramoError('NOT_FOUND', 'PlacementProcess not found', 404, {
        requestId,
        details: { placement_process_id: id, reason: 'placement_process_not_found' },
      });
    }
    const cls = edgeAuthorityClass(current.state, body.to as PlacementState);
    const required = `placement:${cls}`;
    if (!auth.scopes.includes(required)) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', `this transition requires the ${required} scope`, 403, {
        requestId,
        details: { placement_process_id: id, from_state: current.state, to_state: body.to, authority_class: cls, required_scope: required },
      });
    }
    // Authorization has passed above; the reason evidence (E3) is validated in
    // the repository BEFORE any mutation. reason_code is required for a governed
    // terminal edge and must be absent for a non-governed one (registry classifier).
    return this.placements.transition(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        to: body.to as PlacementState,
        reason_code: body.reason_code ?? null,
        reason_detail: body.reason_detail ?? null,
      },
      requestId,
    );
  }

  // E1-d / D-3 — item read aligned to the house pattern: actor-visibility
  // predicate, 404 (never 403) when the row is absent OR not in the actor's
  // visible set. The scope passed, so existence is never disclosed.
  @Get(':id')
  @RequireScopes('placement:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.placements.findByIdForActor({
      tenant_id: auth.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'PlacementProcess not found in tenant (or not visible to actor)', 404, {
        requestId,
        details: { placement_process_id: id, reason: 'placement_process_not_found' },
      });
    }
    return view;
  }

  // E1-d / Scope B — the placement event/reason timeline. The AUTHORIZED detail
  // surface (D-1): reason_code, reason_label_snapshot and permitted reason_detail
  // are returned HERE and nowhere broader. The placement is first loaded through
  // the SAME visibility guard as the item read (findByIdForActor → 404 if absent
  // or not visible) BEFORE any event is read, so the event log cannot be used to
  // probe existence. Legacy/non-governed events carry null reason fields (never
  // fabricated). reason_detail is null by construction for a PROHIBITED-policy
  // code (the E3 classifier rejects content), so no extra filtering is needed.
  @Get(':id/events')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:read')
  @RequireSiteMatch()
  async listEvents(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ items: PlacementProcessEventView[] }> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const placement = await this.placements.findByIdForActor({
      tenant_id: auth.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (placement === null) {
      throw new AramoError('NOT_FOUND', 'PlacementProcess not found in tenant (or not visible to actor)', 404, {
        requestId,
        details: { placement_process_id: id, reason: 'placement_process_not_found' },
      });
    }
    const items = await this.events.listEvents(auth.tenant_id, id);
    return { items };
  }
}
