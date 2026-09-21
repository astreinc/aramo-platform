import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { WIRED_LLM_PROVIDERS, isLlmProvider, type LlmProvider } from '@aramo/ai-draft';

import {
  TenantLlmKeyService,
  type TenantLlmKeyStatus,
  type TenantLlmOverview,
} from './tenant-llm-key.service.js';

// TENANT-LLM-1/2 §P2 — the per-tenant, MULTI-PROVIDER BYO LLM admin API
// (Settings → Integrations → AI/LLM). Guard chain = the ATS three-axis pattern
// (as the connector controller): JwtAuthGuard + EntitlementGuard('ats') +
// RolesGuard + integration:read (overview/status) / integration:write
// (select-provider, set/rotate/clear). tenant_id ALWAYS from AuthContext, never
// the body/path. Keys are WRITE-ONLY — never returned by any endpoint; status is
// a has-key boolean only.
//
// The {provider} path segment is validated against the WIRED set
// (WIRED_LLM_PROVIDERS) — an unwired/unknown provider is rejected with
// VALIDATION_ERROR (§4.5 no-dead-knobs), never routed to a missing adapter.
@Controller('v1/integrations/llm')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TenantLlmController {
  constructor(private readonly service: TenantLlmKeyService) {}

  // Overview: the active provider + each wired provider's has-key status. Drives
  // the multi-provider admin panel in ONE read (no dead knobs — only wired
  // providers appear; the FE renders the rest as "coming soon").
  //
  // NOTE: this is `/overview` (not the bare `/v1/integrations/llm`) deliberately —
  // the sibling connector controller (@Controller('v1/integrations')) owns
  // `GET /v1/integrations/:id`, which would otherwise capture `/v1/integrations/llm`
  // as id='llm'. A distinct sub-path avoids that route collision.
  @Get('overview')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async overview(@AuthContext() authContext: AuthContextType): Promise<TenantLlmOverview> {
    return this.service.overview(authContext.tenant_id);
  }

  // Select the tenant's active provider (server-owned). The value is validated
  // against the wired set here (fast 400) and again by the setting's validator.
  @Put('active-provider')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async selectActiveProvider(
    @AuthContext() authContext: AuthContextType,
    @Body() body: { provider?: unknown },
    @RequestId() requestId: string,
  ): Promise<TenantLlmOverview> {
    const provider = this.requireWiredProvider(body?.provider, requestId, 'provider');
    await this.service.setActiveProvider({
      tenant_id: authContext.tenant_id,
      actor_id: authContext.sub,
      provider,
      requestId,
    });
    return this.service.overview(authContext.tenant_id);
  }

  // Set OR rotate — idempotent write of the tenant's key for a provider. The raw
  // value is stored in Secrets Manager and NEVER returned; the response is the
  // has-key status.
  @Put(':provider/key')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async setKey(
    @AuthContext() authContext: AuthContextType,
    @Param('provider') providerParam: string,
    @Body() body: { api_key?: unknown },
    @RequestId() requestId: string,
  ): Promise<TenantLlmKeyStatus> {
    const provider = this.requireWiredProvider(providerParam, requestId, 'provider');
    if (typeof body?.api_key !== 'string' || body.api_key.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'api_key must be a non-empty string', 400, {
        requestId,
        details: { field: 'api_key' },
      });
    }
    await this.service.setKey({
      tenant_id: authContext.tenant_id,
      actor_id: authContext.sub,
      provider,
      api_key: body.api_key,
      requestId,
    });
    return this.service.status(authContext.tenant_id, provider);
  }

  @Delete(':provider/key')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async clearKey(
    @AuthContext() authContext: AuthContextType,
    @Param('provider') providerParam: string,
    @RequestId() requestId: string,
  ): Promise<TenantLlmKeyStatus> {
    const provider = this.requireWiredProvider(providerParam, requestId, 'provider');
    await this.service.clearKey({
      tenant_id: authContext.tenant_id,
      actor_id: authContext.sub,
      provider,
    });
    return this.service.status(authContext.tenant_id, provider);
  }

  @Get(':provider/status')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async status(
    @AuthContext() authContext: AuthContextType,
    @Param('provider') providerParam: string,
    @RequestId() requestId: string,
  ): Promise<TenantLlmKeyStatus> {
    const provider = this.requireWiredProvider(providerParam, requestId, 'provider');
    return this.service.status(authContext.tenant_id, provider);
  }

  // §4.5 no-dead-knobs — reject any non-wired provider at the boundary with the
  // allowed-set surfaced, before the request reaches an adapter that may not exist.
  private requireWiredProvider(value: unknown, requestId: string, field: string): LlmProvider {
    if (!isLlmProvider(value)) {
      throw new AramoError('VALIDATION_ERROR', 'unsupported LLM provider', 400, {
        requestId,
        details: { field, reason: 'provider_not_wired', allowed: [...WIRED_LLM_PROVIDERS] },
      });
    }
    return value;
  }
}
