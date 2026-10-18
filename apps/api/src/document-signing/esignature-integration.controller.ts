import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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

  @Post(':provider/connect')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async connect(
    @Param('provider') provider: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ authorize_url: string }> {
    return this.integration.connect(auth.tenant_id, provider, auth.sub, requestId);
  }

  /**
   * The provider's OAuth redirect (a top-level browser navigation: the session
   * cookie authenticates the same admin who started the connect). Always lands
   * back on Settings → Integrations with an outcome flag; never echoes provider
   * errors or tokens.
   */
  @Get(':provider/callback')
  @RequireScopes('integration:write')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Res() res: Response,
  ): Promise<void> {
    const back = (outcome: 'connected' | 'failed') =>
      res.redirect(302, `/ats/admin/settings/integrations?esignature=${encodeURIComponent(provider)}-${outcome}`);
    if (typeof query['code'] !== 'string' || typeof query['state'] !== 'string') {
      back('failed');
      return;
    }
    try {
      await this.integration.completeConnect({ tenant_id: auth.tenant_id, provider, actor_id: auth.sub, code: query['code'], state: query['state'], params: query, requestId });
      back('connected');
    } catch {
      back('failed');
    }
  }

  @Post(':provider/disconnect')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async disconnect(
    @Param('provider') provider: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<ESignatureOverview> {
    return this.integration.disconnect(auth.tenant_id, provider, auth.sub, requestId);
  }
}
