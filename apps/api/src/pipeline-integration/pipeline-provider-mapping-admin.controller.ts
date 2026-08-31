import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { PipelineProviderMappingAdminService } from './pipeline-provider-mapping-admin.service.js';
import type { AuthorPipelineMappingRequest } from './dto/author-pipeline-mapping-request.dto.js';

// L2-I (D1) — the Pipeline provider-disposition MAPPING administration surface. A DELIBERATELY
// THIN controller: it authenticates + authorizes (A2 guard chain), validates the request SHAPE,
// resolves the tenant/connection context, invokes the mapping-admin service, and serializes.
// It holds NO mapping rules — the service is the sole authority for canonical-target validation,
// COMPLETE / DOWNSTREAM_OUTCOME prohibition, mapping-set versioning, and connection concealment.
// Author is gated by the NARROW `integration:pipeline-mapping:write`; list reuses `integration:read`.
@Controller('v1/integrations/:connectionId/pipeline-provider-mappings')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class PipelineProviderMappingAdminController {
  constructor(private readonly admin: PipelineProviderMappingAdminService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @RequestId() requestId: string,
  ): Promise<{ items: ReadonlyArray<{ provider_token: string; disposition: string; mapped_target: string | null; target_kind: string | null }> }> {
    const items = await this.admin.listMappings({ tenant_id: authContext.tenant_id, connection_id: connectionId, requestId });
    return { items };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('integration:pipeline-mapping:write')
  async author(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @Body() body: AuthorPipelineMappingRequest,
    @RequestId() requestId: string,
  ): Promise<{ status: 'authored' }> {
    // Thin shape validation only — the mapping rules live in the service.
    if (typeof body?.provider_token !== 'string' || body.provider_token.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'provider_token is required', 400, { requestId });
    }
    await this.admin.authorMapping({
      tenant_id: authContext.tenant_id,
      connection_id: connectionId,
      provider_token: body.provider_token,
      mapped_target: body.mapped_target ?? null,
      disposition: body.disposition,
      authority_mode: body.authority_mode,
      requestId,
    });
    return { status: 'authored' };
  }
}
