import {
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
import type { DisputeActionResponse, TenantDisputeSummary } from '@aramo/intelligence-contracts';

import {
  PortalDisputeDisposeDto,
  PortalDisputeRequestInfoDto,
  type PortalDisputeDispositionResultDto,
  type PortalDisputeTenantDetailDto,
  type PortalDisputeTenantItemDto,
  type PortalDisputeTenantListDto,
} from './dto/portal-dispute-disposition.dto.js';
import { IntelligenceAccess } from './intelligence-access.js';

// Portal P3b → ATI-SEP-1 T10 WP3b (Addendum A3 T10-2) — the TENANT-side
// dispute-disposition surface, re-pointed onto Talent Intelligence (M-4). The
// talent raises a dispute on a TI assertion; the reviewer here disposes it:
//
//   GET  /                  → TI GET  /v1/tenants/:tenant/disputes (?all=1 → status=all)
//   GET  /:id               → TI GET  /v1/tenants/:tenant/disputes/:id
//   POST /:id/triage        → TI triage        (OPEN → UNDER_REVIEW; assertion DISPUTED)
//   POST /:id/request-info  → TI request-info  (a recorded TENANT note; stays UNDER_REVIEW)
//   POST /:id/correct       → TI correct       (RESOLVED_CORRECTED; assertion REVOKED)
//   POST /:id/uphold        → TI uphold        (RESOLVED_UPHELD; assertion VALID)
//   POST /:id/extend        → TI extend        (the single +15d reinvestigation extension)
//
// `identity:resolve`-gated (unchanged); tenant + actor come ONLY from the JWT.
// FAIL-SOFT: the worklist answers 200 with no items + intelligence_status when TI
// is not configured / not entitled / down; the detail + actions refuse with 503
// INTELLIGENCE_UNAVAILABLE (details.intelligence_status). A dispute the tenant
// holds no reference to is a uniform 404. TI outcomes never mutate ATS data.

function toItem(d: TenantDisputeSummary): PortalDisputeTenantItemDto {
  return {
    dispute_id: d.dispute_id,
    talent_record_ids: d.external_talent_ids,
    assertion_id: d.assertion_id,
    item_type: d.assertion_type,
    contributed_by: d.contributed_by,
    status: d.status,
    arrived_at: d.opened_at,
    updated_at: d.updated_at,
    triage_due_at: d.triage_due_at,
    reinvestigation_due_at: d.reinvestigation_due_at,
  };
}

const result = (r: DisputeActionResponse): PortalDisputeDispositionResultDto => ({ dispute_id: r.dispute_id, status: r.status });

@Controller('v1/talent/identity/portal-disputes')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class PortalDisputeDispositionController {
  constructor(private readonly ti: IntelligenceAccess) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('all') all: string | undefined,
    @Query('cursor') cursor: string | undefined,
  ): Promise<PortalDisputeTenantListDto> {
    const tenantId = authContext.tenant_id;
    const page = await this.ti.read(tenantId, (c) =>
      c.listTenantDisputes(tenantId, {
        status: all === '1' ? 'all' : 'open',
        limit: 100,
        ...(cursor !== undefined && cursor.length > 0 ? { cursor } : {}),
      }),
    );
    if (page.value === null) return { intelligence_status: page.status, disputes: [], next_cursor: null };
    return { intelligence_status: 'ENABLED', disputes: page.value.items.map(toItem), next_cursor: page.value.next_cursor };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async detail(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortalDisputeTenantDetailDto> {
    const tenantId = authContext.tenant_id;
    const d = await this.ti.act(tenantId, requestId, (c) => c.getTenantDispute(tenantId, id));
    return {
      ...toItem(d),
      opened_at: d.opened_at,
      assertion_status: d.assertion_status,
      assertion_payload: d.assertion_payload,
      resolution_note: d.resolution_note,
      no_transition_reason: d.no_transition_reason,
      reinvestigation_extended_at: d.sla.reinvestigation_extended_at,
      statements: d.statements.map((s) => ({ author: s.author, statement: s.statement, created_at: s.created_at })),
    };
  }

  @Post(':id/triage')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async triage(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortalDisputeDispositionResultDto> {
    const by = { tenant_id: authContext.tenant_id, actor: authContext.sub };
    return result(await this.ti.act(by.tenant_id, requestId, (c) => c.triageDispute(id, by)));
  }

  @Post(':id/request-info')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async requestInfo(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PortalDisputeRequestInfoDto,
  ): Promise<PortalDisputeDispositionResultDto> {
    const by = { tenant_id: authContext.tenant_id, actor: authContext.sub, note: body.note };
    return result(await this.ti.act(by.tenant_id, requestId, (c) => c.requestDisputeInfo(id, by)));
  }

  @Post(':id/correct')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async correct(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PortalDisputeDisposeDto,
  ): Promise<PortalDisputeDispositionResultDto> {
    const by = { tenant_id: authContext.tenant_id, actor: authContext.sub, note: body.note };
    return result(await this.ti.act(by.tenant_id, requestId, (c) => c.correctDispute(id, by)));
  }

  @Post(':id/uphold')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async uphold(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PortalDisputeDisposeDto,
  ): Promise<PortalDisputeDispositionResultDto> {
    const by = { tenant_id: authContext.tenant_id, actor: authContext.sub, note: body.note };
    return result(await this.ti.act(by.tenant_id, requestId, (c) => c.upholdDispute(id, by)));
  }

  @Post(':id/extend')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async extend(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortalDisputeDispositionResultDto> {
    const by = { tenant_id: authContext.tenant_id, actor: authContext.sub };
    return result(await this.ti.act(by.tenant_id, requestId, (c) => c.extendDispute(id, by)));
  }
}
