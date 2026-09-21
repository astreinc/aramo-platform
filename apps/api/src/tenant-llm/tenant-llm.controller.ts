import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TenantLlmKeyService, type TenantLlmKeyStatus } from './tenant-llm-key.service.js';

// TENANT-LLM-1 §P2 — the per-tenant Anthropic key admin API.
// Settings → Integrations → AI/LLM → Anthropic. Guard chain = the ATS three-axis
// pattern (as the connector controller): JwtAuthGuard + EntitlementGuard('ats') +
// RolesGuard + integration:read (status) / integration:write (set/rotate/clear).
// tenant_id ALWAYS from AuthContext, never the body. The key is WRITE-ONLY — it is
// never returned by any endpoint; status is a has-key boolean only.
@Controller('v1/integrations/llm')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TenantLlmController {
  constructor(private readonly service: TenantLlmKeyService) {}

  // Set OR rotate — idempotent write of the tenant's key. The raw value is stored
  // in Secrets Manager and NEVER returned; the response is the has-key status.
  @Put('anthropic/key')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async setKey(
    @AuthContext() authContext: AuthContextType,
    @Body() body: { api_key?: unknown },
    @RequestId() requestId: string,
  ): Promise<TenantLlmKeyStatus> {
    if (typeof body?.api_key !== 'string' || body.api_key.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'api_key must be a non-empty string', 400, {
        requestId,
        details: { field: 'api_key' },
      });
    }
    await this.service.setKey({
      tenant_id: authContext.tenant_id,
      actor_id: authContext.sub,
      api_key: body.api_key,
      requestId,
    });
    return this.service.status(authContext.tenant_id);
  }

  @Delete('anthropic/key')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async clearKey(
    @AuthContext() authContext: AuthContextType,
  ): Promise<TenantLlmKeyStatus> {
    await this.service.clearKey({ tenant_id: authContext.tenant_id, actor_id: authContext.sub });
    return this.service.status(authContext.tenant_id);
  }

  @Get('anthropic/status')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async status(
    @AuthContext() authContext: AuthContextType,
  ): Promise<TenantLlmKeyStatus> {
    return this.service.status(authContext.tenant_id);
  }
}
