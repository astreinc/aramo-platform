import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { ProposalService, type ServicePrincipal } from '@aramo/intelligence-core';
import { INTELLIGENCE_PROPOSALS_SCOPE, type ProposalView } from '@aramo/intelligence-contracts';

import { RequireScope, ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';

import { lifecycle } from './lifecycle-errors.js';

// ATI-SEP-1 T10 M-2 — record a human's decision on a trust proposal (scope intelligence:proposals).
//   POST /v1/proposals/:id/dismiss { source_tenant_id, actor, justification }   200 ProposalView
//   POST /v1/proposals/:id/act     { source_tenant_id, actor, action, note? }   200 ProposalView
// OPEN-only (409 PROPOSAL_NOT_OPEN). Executes nothing.

@Controller('v1/proposals')
@UseGuards(ServiceTokenGuard)
@RequireScope(INTELLIGENCE_PROPOSALS_SCOPE)
export class ProposalsController {
  constructor(private readonly proposals: ProposalService) {}

  @Post(':id/dismiss')
  @HttpCode(HttpStatus.OK)
  dismiss(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<ProposalView> {
    return lifecycle(() => this.proposals.dismiss(id, body, req.servicePrincipal as ServicePrincipal));
  }

  @Post(':id/act')
  @HttpCode(HttpStatus.OK)
  act(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: unknown, @Req() req: ServiceRequest): Promise<ProposalView> {
    return lifecycle(() => this.proposals.act(id, body, req.servicePrincipal as ServicePrincipal));
  }
}
