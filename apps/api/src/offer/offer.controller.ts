import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { OfferRepository, type OfferView } from '@aramo/placement';

import { CreateOfferDto, TransitionOfferDto } from './dto/offer.dto.js';

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
  constructor(private readonly offers: OfferRepository) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('offer:create')
  async create(
    @Body() dto: CreateOfferDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<OfferView> {
    return this.offers.create({
      tenant_id: auth.tenant_id,
      submittal_id: dto.submittal_id,
      requisition_id: dto.requisition_id,
      talent_record_id: dto.talent_record_id,
      proposed_start_date: dto.proposed_start_date,
      offer_expires_at: dto.offer_expires_at,
      client_offer_reference: dto.client_offer_reference,
      offer_terms_summary: dto.offer_terms_summary,
      actor_id: auth.sub,
      correlation_id: requestId,
    });
  }

  @Get(':id')
  @RequireScopes('offer:create')
  async read(
    @Param('id', ParseUUIDPipe) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<OfferView> {
    const view = await this.offers.findById(auth.tenant_id, id);
    if (view === null) {
      throw new AramoError('NOT_FOUND', 'Offer not found in tenant', 404, { requestId, details: { id } });
    }
    return view;
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
      decline_reason: dto.decline_reason,
    });
  }
}
