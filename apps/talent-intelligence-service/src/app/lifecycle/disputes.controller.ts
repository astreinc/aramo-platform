import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { DisputeService, type ServicePrincipal } from '@aramo/intelligence-core';
import {
  INTELLIGENCE_DISPUTES_SCOPE,
  type DisputeActionResponse,
  type PortalDisputeListResponse,
  type PortalDisputeView,
} from '@aramo/intelligence-contracts';

import { RequireScope, ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';

import { lifecycle } from './lifecycle-errors.js';

// ATI-SEP-1 T10 M-4 (Addendum A3 T10-2) — talent-raised disputes (scope intelligence:disputes).
// Portal side (the ATS calls on the talent's behalf, naming the talent's own references):
//   POST /v1/disputes                      201 PortalDisputeView (an open dispute of the same assertion is returned)
//   GET  /v1/disputes?reference=…&status=  200 PortalDisputeListResponse
//   GET  /v1/disputes/:id?reference=…      200 PortalDisputeView
//   POST /v1/disputes/:id/respond          200 PortalDisputeView
//   POST /v1/disputes/:id/withdraw         200 PortalDisputeView
// Tenant disposition ({ source_tenant_id, actor, note? }):
//   POST /v1/disputes/:id/{triage,request-info,correct,uphold,extend}  200 DisputeActionResponse
// Refusals: LIFECYCLE_REFUSAL_HTTP_STATUS (contracts).

@Controller('v1/disputes')
@UseGuards(ServiceTokenGuard)
@RequireScope(INTELLIGENCE_DISPUTES_SCOPE)
export class DisputesController {
  constructor(private readonly disputes: DisputeService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  open(@Body() body: unknown, @Req() req: ServiceRequest): Promise<PortalDisputeView> {
    return lifecycle(() => this.disputes.open(body, req.servicePrincipal as ServicePrincipal));
  }

  @Get()
  list(@Query('reference') reference: unknown, @Query('status') status: unknown, @Req() req: ServiceRequest): Promise<PortalDisputeListResponse> {
    return lifecycle(() => this.disputes.listForPortal(reference, req.servicePrincipal as ServicePrincipal, status));
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string, @Query('reference') reference: unknown, @Req() req: ServiceRequest): Promise<PortalDisputeView> {
    return lifecycle(() => this.disputes.getForPortal(id, reference, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/respond')
  @HttpCode(HttpStatus.OK)
  respond(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<PortalDisputeView> {
    return lifecycle(() => this.disputes.respond(id, body, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/withdraw')
  @HttpCode(HttpStatus.OK)
  withdraw(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<PortalDisputeView> {
    return lifecycle(() => this.disputes.withdraw(id, body, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/triage')
  @HttpCode(HttpStatus.OK)
  triage(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<DisputeActionResponse> {
    return lifecycle(() => this.disputes.triage(id, body, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/request-info')
  @HttpCode(HttpStatus.OK)
  requestInfo(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<DisputeActionResponse> {
    return lifecycle(() => this.disputes.requestInfo(id, body, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/correct')
  @HttpCode(HttpStatus.OK)
  correct(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<DisputeActionResponse> {
    return lifecycle(() => this.disputes.correct(id, body, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/uphold')
  @HttpCode(HttpStatus.OK)
  uphold(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<DisputeActionResponse> {
    return lifecycle(() => this.disputes.uphold(id, body, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/extend')
  @HttpCode(HttpStatus.OK)
  extend(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<DisputeActionResponse> {
    return lifecycle(() => this.disputes.extend(id, body, req.servicePrincipal as ServicePrincipal));
  }
}
