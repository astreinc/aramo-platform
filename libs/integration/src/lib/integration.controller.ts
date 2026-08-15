import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { IntegrationConnectionView } from './domain/integration-connection.js';
import {
  ConnectionServiceError,
  IntegrationConnectionService,
} from './connection/integration-connection.service.js';
import type {
  CreateIntegrationConnectionDto,
  SetCredentialDto,
  UpdateIntegrationConnectionDto,
} from './dto/connection-management.dto.js';

// IntegrationController — T8-CONNECTOR-A connector-connection MANAGEMENT API
// (Settings → Integrations, directive §34). PROVIDER-NEUTRAL: no provider name,
// transport, OAuth, webhook, SFTP, polling cadence, or run-now route.
//
// Guard chain (the ATS three-axis pattern):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')                 // tenant axis
//   @RequireScopes('integration:read'|'integration:write')  // scope axis
//
// integration:read governs VISIBILITY (GET); integration:write governs MUTATIONS
// (POST/PATCH/enable/disable). tenant_id ALWAYS from AuthContext, never the body.
// GET responses expose the secret-free view ONLY — never secret_ref, an AWS path,
// or credential material. Credential set is a dedicated WRITE-ONLY endpoint.
@Controller('v1/integrations')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class IntegrationController {
  constructor(private readonly service: IntegrationConnectionService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async list(
    @AuthContext() authContext: AuthContextType,
  ): Promise<{ items: IntegrationConnectionView[] }> {
    const items = await this.service.listConnections(authContext.tenant_id);
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<IntegrationConnectionView> {
    return this.guard(requestId, () => this.service.getConnection(authContext.tenant_id, id));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('integration:write')
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateIntegrationConnectionDto,
    @RequestId() requestId: string,
  ): Promise<IntegrationConnectionView> {
    return this.guard(requestId, () =>
      this.service.createConnection({
        tenant_id: authContext.tenant_id,
        provider_key: body.provider_key,
        provider_account_id: body.provider_account_id ?? null,
      }),
    );
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateIntegrationConnectionDto,
    @RequestId() requestId: string,
  ): Promise<IntegrationConnectionView> {
    return this.guard(requestId, () =>
      this.service.updateConnection(authContext.tenant_id, id, {
        provider_account_id: body.provider_account_id,
      }),
    );
  }

  // Write-only credential set — the raw value is stored in Secrets Manager and
  // NEVER returned. The response is the secret-free view.
  @Post(':id/credential')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async setCredential(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: SetCredentialDto,
    @RequestId() requestId: string,
  ): Promise<IntegrationConnectionView> {
    if (typeof body?.credential !== 'string' || body.credential.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'credential must be a non-empty string', 400, {
        requestId,
        details: { field: 'credential' },
      });
    }
    return this.guard(requestId, () =>
      this.service.setCredential({ tenant_id: authContext.tenant_id, id, credential: body.credential }),
    );
  }

  @Post(':id/enable')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async enable(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<IntegrationConnectionView> {
    return this.guard(requestId, () => this.service.enable(authContext.tenant_id, id));
  }

  @Post(':id/disable')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async disable(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<IntegrationConnectionView> {
    return this.guard(requestId, () => this.service.disable(authContext.tenant_id, id));
  }

  /** Map typed ConnectionServiceError → deterministic tenant-safe HTTP AramoError. */
  private async guard<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ConnectionServiceError) {
        if (err.code === 'CONNECTION_NOT_FOUND') {
          throw new AramoError('NOT_FOUND', 'Integration connection not found in tenant', 404, {
            requestId,
          });
        }
        // Illegal transition / enable-without-credential → 409 conflict.
        throw new AramoError('CONNECTOR_CONFIGURATION_INVALID', err.message, 409, {
          requestId,
          details: { code: err.code },
        });
      }
      throw err;
    }
  }
}
