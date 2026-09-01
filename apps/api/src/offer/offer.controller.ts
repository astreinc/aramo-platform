import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { OfferRepository, maskOfferCompensation, OFFER_READ_FINANCIAL_SCOPE, type OfferView } from '@aramo/placement';
import type { Request } from 'express';

import { CreateOfferDto, TransitionOfferDto } from './dto/offer.dto.js';
import { OfferClientSelectionGate } from './offer-client-selection-gate.service.js';

// Offer Lifecycle (D5) — the minimal governed /v1/offers surface: create a DRAFT
// offer, read one, and drive a governed transition. ONE generic transition route
// (the target state is in the body; governingOfferAction + the ADR-0024 offer
// policy + the DB trigger own legality — no named outcome routes). Authorization:
// offer:create (create), offer:transition (transition). Read is gated by
// offer:create (create-authority reads; no separate offer:read scope this slice).
// Tenant-scoped (offer inherits site context from its submittal/requisition — no
// @RequireSiteMatch, no site_id column on the aggregate).
@Controller('v1/offers')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class OfferController {
  constructor(
    private readonly offers: OfferRepository,
    private readonly clientSelectionGate: OfferClientSelectionGate,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('offer:create')
  async create(
    @Body() dto: CreateOfferDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<OfferView> {
    // L3-E — SELECTED gates Offer creation (P1 / D-4). The ClientSelectionProcess for
    // THIS submittal must be SELECTED; otherwise refuse with
    // OFFER_CLIENT_SELECTION_NOT_SELECTED (409). SELECTED authorizes — it does not
    // auto-create — and there is no compatibility bypass.
    await this.clientSelectionGate.assertSelected({
      tenant_id: auth.tenant_id,
      submittal_id: dto.submittal_id,
      requestId,
    });
    return this.offers.create({
      tenant_id: auth.tenant_id,
      submittal_id: dto.submittal_id,
      requisition_id: dto.requisition_id,
      talent_record_id: dto.talent_record_id,
      proposed_start_date: dto.proposed_start_date,
      offer_expires_at: dto.offer_expires_at,
      client_offer_reference: dto.client_offer_reference,
      offer_terms_summary: dto.offer_terms_summary,
      compensation_type: dto.compensation_type,
      compensation_amount: dto.compensation_amount,
      compensation_currency: dto.compensation_currency,
      compensation_period: dto.compensation_period,
      actor_id: auth.sub,
      correlation_id: requestId,
    });
  }

  // D7 (LOCKED Aramo-Offer-D7-OfferPanel-Wiring v1.0, R-DISCOVERY) — the offer
  // LIST/filter surface the recruiter UI uses to discover an offer from a
  // pipeline row's (requisition_id, talent_record_id) [or submittal_id].
  // L4/P5 — gated on offer:read; the Talent-facing compensation snapshot is MASKED
  // unless the caller also holds offer:read:financial (fail-closed). Visibility-
  // scoped via resolveVisibleRequisitionIds (no offer leaks outside the actor's
  // visible requisitions).
  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('offer:read')
  async list(
    @Query('submittal_id') submittalId: string | undefined,
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('talent_record_id') talentRecordId: string | undefined,
    @AuthContext() auth: AuthContextType,
    @Req() req: Request,
  ): Promise<{ items: OfferView[] }> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const items = await this.offers.list({
      tenant_id: auth.tenant_id,
      ...(submittalId === undefined ? {} : { submittal_id: submittalId }),
      ...(requisitionId === undefined ? {} : { requisition_id: requisitionId }),
      ...(talentRecordId === undefined
        ? {}
        : { talent_record_id: talentRecordId }),
      visible_requisition_ids: visibleReqIds,
    });
    const canSeeFinancial = auth.scopes.includes(OFFER_READ_FINANCIAL_SCOPE);
    return { items: items.map((o) => maskOfferCompensation(o, canSeeFinancial)) };
  }

  @Get(':id')
  @RequireScopes('offer:read')
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<OfferView> {
    const view = await this.offers.findById(auth.tenant_id, id);
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'Offer not found in tenant', 404, { requestId, details: { id } });
    }
    // L4/P5 — fail-closed field-level financial masking.
    return maskOfferCompensation(view, auth.scopes.includes(OFFER_READ_FINANCIAL_SCOPE));
  }

  @Patch(':id')
  @RequireScopes('offer:transition')
  async transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionOfferDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<OfferView> {
    return this.offers.transition({
      tenant_id: auth.tenant_id,
      id,
      to_state: dto.to_state,
      scopes: auth.scopes,
      actor_id: auth.sub,
      correlation_id: requestId,
      proposed_start_date: dto.proposed_start_date,
      offer_expires_at: dto.offer_expires_at,
      client_offer_reference: dto.client_offer_reference,
      offer_terms_summary: dto.offer_terms_summary,
      compensation_type: dto.compensation_type,
      compensation_amount: dto.compensation_amount,
      compensation_currency: dto.compensation_currency,
      compensation_period: dto.compensation_period,
      change_reason: dto.change_reason,
      decline_reason: dto.decline_reason,
    });
  }
}
