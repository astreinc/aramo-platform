import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RequireSiteMatch, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  PlacementRepository,
  PlacementProcessEventRepository,
  PermanentPlacementRepository,
  edgeAuthorityClass,
  type PlacementProcessEventView,
  type PlacementProcessView,
  type PlacementState,
  type PlacementKind,
  type ContractAssignmentEndReason,
  type AssignmentExtensionReason,
  type ConvertToPermanentResult,
  type ContractAssignmentView,
  type AssignmentCommercialView,
  type CommercialProposalView,
  type PermanentPlacementView,
  type PermanentPlacementState,
  type GuaranteeTermsInput,
} from '@aramo/placement';

import {
  CancelCommercialRevisionDto,
  CommercialProposalDecisionDto,
  CommercialProposalDto,
  CommercialProposalTransitionDto,
  CommercialRevisionDto,
  CreatePlacementDto,
  EndAssignmentDto,
  ExtendAssignmentDto,
  FalloffDto,
  PermanentPlacementTransitionDto,
  RemedyCompletionDto,
  TransitionPlacementDto,
} from './dto/placement.dto.js';

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
    private readonly permanent: PermanentPlacementRepository,
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
        // Offer Lifecycle (D6) — the ACCEPTED offer this placement derives from;
        // the repository refuses a create that is not ACCEPTED (VALIDATION_ERROR).
        offer_id: body.offer_id,
        // E1-c offer snapshot — the DTO carries ISO strings (IsDateString); the
        // repository I/O type is Date-typed, so convert at the HTTP boundary.
        offered_at: body.offered_at != null ? new Date(body.offered_at) : undefined,
        proposed_start_date: body.proposed_start_date != null ? new Date(body.proposed_start_date) : undefined,
        offer_expires_at: body.offer_expires_at != null ? new Date(body.offer_expires_at) : undefined,
        client_offer_reference: body.client_offer_reference,
        offer_terms_summary: body.offer_terms_summary,
        // E4 — replacement lineage; the repository validates and persists it (§5).
        replaces_placement_process_id: body.replaces_placement_process_id,
        // Track 7 / T7-P1 — the permanent-vs-contract branch fact (§3.1),
        // persisted once at create. Omitted => NULL (CONTRACT-compatible).
        placement_kind: (body.placement_kind ?? null) as PlacementKind | null,
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
    // The FORWARD STARTED path requires a CONJUNCTION with the edge scope above
    // (placement:activate), BRANCH-DEPENDENT on the persisted placement_kind (§8):
    //   CONTRACT / legacy NULL -> AND assignment:commercials:write (Track 5 / A1-4 —
    //     starting a CONTRACT assignment materialises its initial commercial terms);
    //   PERMANENT              -> AND placement:permanent:transition (Track 7 / T7-P1 —
    //     starting a permanent placement materialises the guarantee aggregate and mints
    //     NO commercial terms, so commercials:write must NOT gate it).
    // Enforced imperatively (data-dependent on to === STARTED and the branch fact),
    // mirroring the E4 replacement conjunction. placement:* / requisition financials
    // NEVER substitute; neither conjunct alone authorises STARTED.
    if (body.to === 'STARTED') {
      if (current.placement_kind === 'PERMANENT') {
        if (!auth.scopes.includes('placement:permanent:transition')) {
          throw new AramoError('INSUFFICIENT_PERMISSIONS', 'starting a permanent placement requires the placement:permanent:transition scope (in conjunction with placement:activate)', 403, {
            requestId,
            details: { placement_process_id: id, to_state: body.to, placement_kind: current.placement_kind, required_scope: 'placement:permanent:transition' },
          });
        }
      } else if (!auth.scopes.includes('assignment:commercials:write')) {
        throw new AramoError('INSUFFICIENT_PERMISSIONS', 'starting an assignment requires the assignment:commercials:write scope (in conjunction with placement:activate)', 403, {
          requestId,
          details: { placement_process_id: id, to_state: body.to, required_scope: 'assignment:commercials:write' },
        });
      }
    }
    // Authorization has passed above; the reason evidence (E3) is validated in
    // the repository BEFORE any mutation. reason_code is required for a governed
    // terminal edge and must be absent for a non-governed one (registry classifier).
    // Track 4 / T4-A1 — org snapshot for the forward STARTED -> ContractAssignment
    // path, passed to the repository which materialises the assignment in the same
    // transaction. INTERIM: caller-supplied; T4-D hardens this to a server-side
    // derive from the requisition (the authoritative source), so the controller
    // never trusts the wire for the org snapshot.
    // Slice #3 (R-INITIAL-END) — a forward STARTED must capture the assignment-owned
    // planned end (required at the business operation; the requisition term prefills
    // it FE-side). The DB column stays nullable only for backfill, never for a new
    // forward create. A target-dependent policy, so enforced here (not the validator).
    if (body.to === 'STARTED' && body.assignment_expected_end_at == null) {
      throw new AramoError(
        'PLACEMENT_START_CONTEXT_REQUIRED',
        'a forward STARTED requires assignment_expected_end_at (the assignment planned end)',
        422,
        { requestId, details: { reason: 'expected_end_at_required' } },
      );
    }
    const assignment_context =
      body.to === 'STARTED' && body.assignment_company_id != null
        ? {
            company_id: body.assignment_company_id,
            site_id: body.assignment_site_id ?? null,
            company_department_id: body.assignment_department_id ?? null,
            expected_end_at: body.assignment_expected_end_at ?? null,
          }
        : null;
    return this.placements.transition(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        to: body.to as PlacementState,
        reason_code: body.reason_code ?? null,
        reason_detail: body.reason_detail ?? null,
        assignment_context,
        // Track 5 / T5-P1 — actual commercial terms + the recording principal
        // (JWT sub). The repository REQUIRES commercial_terms for STARTED and
        // REJECTS it otherwise, then materialises the initial Assignment Rate
        // Version in the same transaction as the ContractAssignment.
        commercial_terms: body.commercial_terms ?? null,
        recorded_by: auth.sub,
        // Track 7 / T7-P1 — governed guarantee terms for a PERMANENT STARTED. The
        // repository REQUIRES it for a PERMANENT start and REJECTS it otherwise.
        guarantee_terms: (body.guarantee_terms ?? null) as GuaranteeTermsInput | null,
      },
      requestId,
    );
  }

  // Track 4 / T4-D — end the ContractAssignment of a STARTED placement (ACTIVE ->
  // ENDED, with the ratified end reason). Gated by the DEDICATED assignment:end
  // authority (mirrors the placement authoritative tier: AM/TA/TO, not recruiter) —
  // NOT reused from placement:* or requisition:assign (§7). The repository writes
  // the state flip and the placement.assignment.ended outbox event atomically.
  @Post(':id/assignment/end')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:end')
  async endAssignment(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EndAssignmentDto,
  ): Promise<{ ok: true }> {
    await this.placements.endAssignment(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        end_reason: body.end_reason as ContractAssignmentEndReason,
        // T6-B3 §16 — the acting principal (JWT sub) is recorded as cancelled_by on
        // every future commercial version END reconciliation withdraws. END authority
        // (assignment:end) alone drives this internal effect — NOT a second scope (§14).
        ended_by: auth.sub,
      },
      requestId,
    );
    return { ok: true };
  }

  // Slice #3 (LOCKED Aramo-Assignment-Extension v1.0) — extend an ACTIVE assignment's
  // planned end strictly forward. NO lifecycle transition (R-EXTENSION-NOT-STATE),
  // capacity-neutral. Authority is assignment:extend — SEPARATE from assignment:end
  // (extend and terminate are opposite powers). :id is the owning placement (house-
  // uniform — the assignment is addressed through its placement). Returns the fresh
  // assignment view (expected_end_at updated, ending_soon re-derived).
  @Post(':id/assignment/extend')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:extend')
  async extendAssignment(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ExtendAssignmentDto,
  ): Promise<ContractAssignmentView> {
    return this.placements.extendAssignment(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        new_expected_end_at: body.new_expected_end_at,
        reason: body.reason as AssignmentExtensionReason,
        comment: body.comment ?? null,
        actor_id: auth.sub,
        source: 'MANUAL',
      },
      requestId,
    );
  }

  // Track 7 / T7-PX — Contract-to-Permanent conversion. ONE command (§10): ends the
  // ACTIVE ContractAssignment (CONVERTED_TO_PERMANENT) and mints the NEW permanent
  // PlacementProcess + PermanentPlacement in one atomic placement-domain transaction.
  // :id is the SOURCE contract PlacementProcess id (house-uniform — the assignment is
  // addressed through its owning placement). Authority is the EXACT conjunction
  // assignment:end AND placement:permanent:transition (§9) — both authoritative-tier
  // (AM/TA/TO), recruiter excluded; @RequireScopes is all-or-nothing superset matching,
  // no new scope, no wildcard. No body: guarantee_start_date is derived from T_convert,
  // the guarantee terms come from the governed stored version, the end reason is fixed,
  // and the actor is the JWT sub. The response carries the NEW permanent PlacementProcess
  // id so the FE can navigate to it (§10).
  @Post(':id/assignment/convert-to-permanent')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:end', 'placement:permanent:transition')
  async convertToPermanent(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ConvertToPermanentResult> {
    return this.placements.convertToPermanent(
      { tenant_id: auth.tenant_id, placement_process_id: id, converted_by: auth.sub },
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

  // Track 4 / T4-D (assignment:read) — the authoritative ASSIGNMENT-STATE read for
  // a placement: existence + lifecycle_state + end_reason + started_at + provenance.
  // Dedicated sub-resource under the placement (single read path for assignment
  // state — never embedded in the placement read, which stays on placement:read and
  // the stored openings_available authority). CAPACITY IS DELIBERATELY ABSENT here
  // (it remains A2/B2-gated). Guarded by assignment:read (mirrors assignment:end;
  // placement:* does NOT satisfy it). Least-visibility: the placement is loaded
  // through findByIdForActor FIRST (404 — never 403 — when absent, not visible, or
  // cross-tenant), so this cannot probe existence; a visible placement with no
  // ContractAssignment returns { assignment: null } (coherent absence, not an error).
  @Get(':id/assignment')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:read')
  @RequireSiteMatch()
  async getAssignment(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ assignment: ContractAssignmentView | null }> {
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
    const assignment = await this.placements.findAssignmentByPlacement(auth.tenant_id, id);
    return { assignment };
  }

  // Track 7 / T7-P1 — the PermanentPlacement guarantee read for a placement:
  // existence + lifecycle_state + immutable guarantee snapshot. Dedicated
  // sub-resource under the placement, gated on the DEDICATED placement:permanent:read
  // authority (placement:* / assignment:* do NOT satisfy it — §8 least-visibility).
  // The placement is loaded through findByIdForActor FIRST (404 — never 403 — when
  // absent, cross-tenant, or not visible), so this cannot probe existence; a visible
  // placement with no PermanentPlacement (e.g. a CONTRACT placement) returns
  // { permanent: null } (coherent absence, not an error).
  @Get(':id/permanent')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:permanent:read')
  @RequireSiteMatch()
  async getPermanent(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ permanent: PermanentPlacementView | null }> {
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
    const permanent = await this.permanent.findByPlacement(auth.tenant_id, id);
    return { permanent };
  }

  // Track 7 / T7-P1 — the ONE generic governed guarantee-lifecycle transition
  // (§14): the target is in the body and the typed registry owns legality. P1 legal
  // edge GUARANTEE_ACTIVE -> GUARANTEE_SATISFIED, allowed only on/after the guarantee
  // end date. Gated on the DEDICATED placement:permanent:transition authority
  // (placement:transition / placement:activate do NOT satisfy it). Tenant-scoped
  // like endAssignment (the mutation precedent), NO @RequireSiteMatch: an absent
  // aggregate is PERMANENT_PLACEMENT_NOT_FOUND (404), an illegal edge is
  // PERMANENT_PLACEMENT_STATE_INVALID (422), a premature satisfy is
  // PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID (422).
  @Post(':id/permanent/transition')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:permanent:transition')
  async transitionPermanent(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PermanentPlacementTransitionDto,
  ): Promise<PermanentPlacementView> {
    return this.permanent.transition(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        to: body.to as PermanentPlacementState,
      },
      requestId,
    );
  }

  // Track 7 / T7-P2 — the governed guarantee-falloff command (§3.2 / §11). Records a
  // qualifying post-start falloff (effective date + governed closed-registry reason) and
  // atomically transitions GUARANTEE_ACTIVE -> FELL_OFF -> the deterministic remedy-due
  // state (from the immutable snapshot remedy policy). Gated on placement:permanent:
  // transition (falloff is a lifecycle transition). Tenant-scoped like the other permanent
  // mutations (NO @RequireSiteMatch); actor (recorded_by) = JWT sub, never the body. An
  // absent aggregate is 404; a non-active state 422; an out-of-window/invalid-reason 422.
  @Post(':id/permanent/falloff')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:permanent:transition')
  async recordPermanentFalloff(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: FalloffDto,
  ): Promise<PermanentPlacementView> {
    return this.permanent.recordFalloff(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        effective_date: body.effective_date,
        reason: body.reason,
        recorded_by: auth.sub,
      },
      requestId,
    );
  }

  // Track 7 / T7-P2 — evidence-gated remedy completion (§9 / §11). Requires the aggregate
  // in a remedy-due state and DISTINCT authority: gated on the DEDICATED
  // placement:remedy:resolve scope (placement:permanent:transition does NOT satisfy it —
  // remedy resolution is high-consequence). Evidence: replacement_placement_process_id
  // (REPLACEMENT — a governed same-tenant/same-requisition permanent placement that reached
  // STARTED, evidence-linkage only, NOT an E4 predecessor) OR external_reference
  // (REFUND/PRORATED_CREDIT — a bounded governed settlement/credit reference). The caller
  // NEVER supplies the amount. completed_by = JWT sub. Double completion is a 409.
  @Post(':id/permanent/remedy/complete')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('placement:remedy:resolve')
  async completePermanentRemedy(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RemedyCompletionDto,
  ): Promise<PermanentPlacementView> {
    return this.permanent.completeRemedy(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        replacement_placement_process_id: body.replacement_placement_process_id ?? null,
        external_reference: body.external_reference ?? null,
        completed_by: auth.sub,
      },
      requestId,
    );
  }

  // Track 5 / T5-P2 — the commercial projection of a placement's assignment: the
  // CURRENT effective AssignmentRateVersion (actuals) + DEC-5 derived margin/markup/
  // spread, computed on read. Gated on assignment:commercials:read (a DEDICATED
  // financial scope — NEVER satisfied by assignment:read / placement:read /
  // requisition:read; least-visibility, Directive §4). The placement is loaded
  // through findByIdForActor FIRST (404 — never 403 — when absent, cross-tenant, or
  // not visible), so the commercial scope cannot probe existence nor reveal a hidden
  // assignment (boundary O). A visible placement with no assignment or no active
  // commercial version returns { commercials: null } (coherent absence, not an error).
  @Get(':id/assignment/commercials')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:commercials:read')
  @RequireSiteMatch()
  async getAssignmentCommercials(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ commercials: AssignmentCommercialView | null }> {
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
    const commercials = await this.placements.findAssignmentCommercialProjection(auth.tenant_id, id, requestId);
    return { commercials };
  }

  // Track 6 / T6-B2 — the first governed POST-START commercial revision. Open-tail
  // only: the repository closes the current open window at the resolved effective
  // instant and appends the successor, atomically and serialized against
  // endAssignment. Guarded by the DEDICATED write scope assignment:commercials:write
  // — now a post-start enforcement site (§9): assignment:commercials:read NEVER
  // satisfies it, and placement:* / assignment:update do NOT substitute. Tenant-scoped
  // like endAssignment (the mutation precedent); NO @RequireSiteMatch (§10). The
  // recording principal (recorded_by) is the JWT subject, never the wire. Absent /
  // not-ACTIVE / no-open-version resolve to 404 (never 403); a window conflict is a
  // governed 409 (ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT).
  @Post(':id/assignment/commercials/revisions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('assignment:commercials:write')
  async createAssignmentCommercialRevision(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CommercialRevisionDto,
  ): Promise<{ commercials: AssignmentCommercialView }> {
    const commercials = await this.placements.createCommercialRevision(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        pay_rate_amount: body.pay_rate_amount,
        bill_rate_amount: body.bill_rate_amount,
        currency: body.currency,
        rate_period: body.rate_period,
        effective_from: body.effective_from ?? null,
        change_reason: body.change_reason,
        recorded_by: auth.sub,
      },
      requestId,
    );
    return { commercials };
  }

  // Track 6 / T6-B3 — explicit cancellation of a FUTURE open-tail commercial
  // revision. Gated by the SAME write scope as a revision (assignment:commercials:write,
  // §13) — assignment:commercials:read / assignment:update / placement:* NEVER
  // substitute. Least-visibility like the reads: the placement is loaded through
  // findByIdForActor FIRST (404 — never 403 — when absent, cross-tenant, or not
  // visible), so the write scope cannot probe a hidden assignment. The repository
  // then enforces eligibility (future open tail on an ACTIVE assignment) atomically:
  // an unknown revision, an already-cancelled/non-future/interior target, or an ended
  // assignment resolve to 404 / 409 (ASSIGNMENT_COMMERCIAL_REVISION_CONFLICT). The
  // acting principal (cancelled_by) is the JWT subject, never the wire. Returns the
  // refreshed non-cancelled series (§12), never cancellation metadata.
  @Post(':id/assignment/commercials/revisions/:revisionId/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:commercials:write')
  async cancelAssignmentCommercialRevision(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() body: CancelCommercialRevisionDto,
    @Req() req: Request,
  ): Promise<{ items: AssignmentCommercialView[] }> {
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
    const items = await this.placements.cancelCommercialRevision(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        revision_id: revisionId,
        cancellation_reason_code: body.cancellation_reason_code,
        cancelled_by: auth.sub,
      },
      requestId,
    );
    return { items };
  }

  // Track 6 / T6-B2 — the commercial version-SERIES read (B4 substrate): non-cancelled
  // rate versions (historical + current + future) for the assignment, effective_from
  // DESC. Same DEDICATED financial scope + least-visibility as the point-in-time read:
  // the placement is loaded through findByIdForActor FIRST (404 — never 403 — when
  // absent, cross-tenant, or not visible). A visible placement with no assignment /
  // no versions returns { items: [] } (coherent absence, not an error). This is the
  // uncapped series read — NEVER the fail-closed single-current resolver.
  @Get(':id/assignment/commercials/revisions')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:commercials:read')
  @RequireSiteMatch()
  async listAssignmentCommercialRevisions(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ items: AssignmentCommercialView[] }> {
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
    const items = await this.placements.listAssignmentCommercialRevisions(auth.tenant_id, id);
    return { items };
  }

  // ==========================================================================
  // Slice #4 — Commercial Approval (LOCKED Aramo-Commercial-Approval-Directive-
  // v1_0). The CommercialRevisionProposal governance surface IN FRONT OF the
  // revision write. Propose/submit/withdraw are proposer scope:write; margin-
  // approve / client-approve / apply / reject are commercials:approve authority
  // acts (SoD + ADR-0024 fail-closed). APPLY reuses createCommercialRevision.
  // ==========================================================================

  // Propose the next commercial revision (INTENT). Creates a DRAFT proposal, NEVER
  // an AssignmentRateVersion. Same write scope as a revision; absent / not-ACTIVE /
  // no-open-version → 404; a live proposal already present → 409
  // (COMMERCIAL_PROPOSAL_ALREADY_LIVE). requested_by is the JWT subject.
  @Post(':id/assignment/commercials/proposals')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('assignment:commercials:write')
  async createCommercialProposal(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CommercialProposalDto,
  ): Promise<{ proposal: CommercialProposalView }> {
    const proposal = await this.placements.createCommercialRevisionProposal(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        pay_rate_amount: body.pay_rate_amount,
        bill_rate_amount: body.bill_rate_amount,
        currency: body.currency,
        rate_period: body.rate_period,
        effective_from: body.effective_from ?? null,
        reason: body.reason,
        requested_by: auth.sub,
      },
      requestId,
    );
    return { proposal };
  }

  // List the assignment's proposals (newest first), each with the derived margin
  // comparison. Financial read scope + least-visibility (findByIdForActor → 404,
  // never 403, when absent / cross-tenant / not visible).
  @Get(':id/assignment/commercials/proposals')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:commercials:read')
  @RequireSiteMatch()
  async listCommercialProposals(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<{ items: CommercialProposalView[] }> {
    await this.assertPlacementVisible(auth.tenant_id, id, req, requestId);
    const items = await this.placements.findCommercialRevisionProposals(auth.tenant_id, id, requestId);
    return { items };
  }

  // Read a single proposal (with the derived margin comparison). Coherent absence
  // returns { proposal: null } after the visibility gate.
  @Get(':id/assignment/commercials/proposals/:proposalId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:commercials:read')
  @RequireSiteMatch()
  async getCommercialProposal(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Req() req: Request,
  ): Promise<{ proposal: CommercialProposalView | null }> {
    await this.assertPlacementVisible(auth.tenant_id, id, req, requestId);
    const proposal = await this.placements.findCommercialRevisionProposalById(auth.tenant_id, id, proposalId, requestId);
    return { proposal };
  }

  // Proposer lifecycle transition (SUBMIT / WITHDRAW) — scope:write, NO authority.
  // An illegal edge → 422 (COMMERCIAL_PROPOSAL_STATE_INVALID).
  @Patch(':id/assignment/commercials/proposals/:proposalId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:commercials:write')
  async transitionCommercialProposal(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: CommercialProposalTransitionDto,
    @Req() req: Request,
  ): Promise<{ proposal: CommercialProposalView }> {
    await this.assertPlacementVisible(auth.tenant_id, id, req, requestId);
    const proposal = await this.placements.transitionCommercialRevisionProposal(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        proposal_id: proposalId,
        action: body.action as 'submit' | 'withdraw',
        actor_id: auth.sub,
      },
      requestId,
    );
    return { proposal };
  }

  // Authority decision (MARGIN_APPROVE / CLIENT_APPROVE / APPLY / REJECT) —
  // commercials:approve + SoD (actor != requested_by → 403
  // COMMERCIAL_PROPOSAL_SELF_APPROVAL) + ADR-0024 fail-closed (no published
  // package → 403 POLICY_DENIED). APPLY reuses createCommercialRevision; its
  // window conflict (409) leaves the proposal APPROVED (reconciliation).
  @Post(':id/assignment/commercials/proposals/:proposalId/decision')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('assignment:commercials:approve')
  async decideCommercialProposal(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() body: CommercialProposalDecisionDto,
    @Req() req: Request,
  ): Promise<{ proposal: CommercialProposalView }> {
    await this.assertPlacementVisible(auth.tenant_id, id, req, requestId);
    const proposal = await this.placements.decideCommercialRevisionProposal(
      {
        tenant_id: auth.tenant_id,
        placement_process_id: id,
        proposal_id: proposalId,
        action: body.action as 'margin_approve' | 'client_approve' | 'apply' | 'reject',
        actor_id: auth.sub,
        scopes: auth.scopes ?? [],
        note: body.note ?? null,
        client_reference: body.client_reference ?? null,
        client_approval_source: body.client_approval_source ?? null,
      },
      requestId,
    );
    return { proposal };
  }

  // Least-visibility gate shared by the proposal reads + governed transitions:
  // load the placement through findByIdForActor and 404 (never 403) when absent,
  // cross-tenant, or not visible — so a financial scope cannot probe a hidden
  // assignment.
  private async assertPlacementVisible(
    tenant_id: string,
    id: string,
    req: Request,
    requestId: string,
  ): Promise<void> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const placement = await this.placements.findByIdForActor({ tenant_id, id, visible_requisition_ids: visibleReqIds });
    if (placement === null) {
      throw new AramoError('NOT_FOUND', 'PlacementProcess not found in tenant (or not visible to actor)', 404, {
        requestId,
        details: { placement_process_id: id, reason: 'placement_process_not_found' },
      });
    }
  }
}
