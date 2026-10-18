import { Body, Controller, Get, HttpCode, HttpStatus, Put, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import type { SignatureProviderKey } from '@aramo/signature-routing';

import { ESignatureIntegrationService, type ESignatureOverview } from './esignature-integration.service.js';

// Multi-Provider directive §E — Settings → Integrations → E-Signature. Reads need
// integration:read; changing the provider needs integration:write (tenant admins).
// Two-segment paths on purpose: GET /v1/integrations/:id would otherwise capture
// "esignature" (same reason the LLM panel uses /overview).
@Controller('v1/integrations/esignature')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ESignatureIntegrationController {
  constructor(private readonly integration: ESignatureIntegrationService) {}

  @Get('overview')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async overview(@AuthContext() auth: AuthContextType): Promise<ESignatureOverview> {
    return this.integration.overview(auth.tenant_id);
  }

  @Put('active-provider')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async selectActive(
    @Body() body: { provider?: SignatureProviderKey },
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ESignatureOverview> {
    return this.integration.select(auth.tenant_id, body?.provider as SignatureProviderKey, auth.sub, requestId);
  }
}
