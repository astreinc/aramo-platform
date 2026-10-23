import { Controller, Get, HttpException, HttpStatus, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { DisputeService, ProposalService, type ServicePrincipal } from '@aramo/intelligence-core';
import {
  INTELLIGENCE_DISPUTES_SCOPE,
  INTELLIGENCE_PROPOSALS_SCOPE,
  isLifecycleId,
  type ProposalListResponse,
  type TenantDisputeListResponse,
  type TenantDisputeView,
} from '@aramo/intelligence-contracts';

import { RequireScope, ServiceTokenGuard, type ServiceRequest } from '../auth/service-token.guard.js';

import { lifecycle } from './lifecycle-errors.js';

// ATI-SEP-1 T10 M-2 / M-4 — the tenant worklists. The tenant is the caller's own
// source system + :source_tenant_id; the tenant must be entitled (403 NOT_ENTITLED)
// and sees only subjects where it holds an ACTIVE reference.
//   GET /v1/tenants/:tenant/disputes?status=open|all|<status>&cursor&limit   (intelligence:disputes)
//   GET /v1/tenants/:tenant/disputes/:id                                     (intelligence:disputes)
//   GET /v1/tenants/:tenant/proposals?status&kind&cursor&limit               (intelligence:proposals)

function tenantOf(raw: string): string {
  if (!isLifecycleId(raw)) throw new HttpException({ error: { code: 'INVALID_REQUEST', message: 'invalid tenant id' } }, HttpStatus.BAD_REQUEST);
  return raw;
}

@Controller('v1/tenants/:source_tenant_id')
@UseGuards(ServiceTokenGuard)
export class TenantWorklistsController {
  constructor(
    private readonly disputes: DisputeService,
    private readonly proposals: ProposalService,
  ) {}

  @Get('disputes')
  @RequireScope(INTELLIGENCE_DISPUTES_SCOPE)
  listDisputes(
    @Param('source_tenant_id') tenant: string,
    @Query() query: Record<string, unknown>,
    @Req() req: ServiceRequest,
  ): Promise<TenantDisputeListResponse> {
    return lifecycle(() => this.disputes.listForTenant(tenantOf(tenant), req.servicePrincipal as ServicePrincipal, query));
  }

  @Get('disputes/:id')
  @RequireScope(INTELLIGENCE_DISPUTES_SCOPE)
  getDispute(
    @Param('source_tenant_id') tenant: string,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: ServiceRequest,
  ): Promise<TenantDisputeView> {
    return lifecycle(() => this.disputes.getForTenant(tenantOf(tenant), id, req.servicePrincipal as ServicePrincipal));
  }

  @Get('proposals')
  @RequireScope(INTELLIGENCE_PROPOSALS_SCOPE)
  listProposals(
    @Param('source_tenant_id') tenant: string,
    @Query() query: Record<string, unknown>,
    @Req() req: ServiceRequest,
  ): Promise<ProposalListResponse> {
    return lifecycle(() => this.proposals.list(tenantOf(tenant), req.servicePrincipal as ServicePrincipal, query));
  }
}
