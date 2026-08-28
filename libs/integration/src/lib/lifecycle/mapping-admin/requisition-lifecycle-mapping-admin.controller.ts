import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type {
  MappingRowRequest,
  MappingSetRowsRequest,
} from '../../dto/mapping-admin-request.dto.js';

import {
  MAPPING_DISPOSITION,
  isMappingAdminAllowedAction,
  type DraftMappingRowInput,
  type MappingDisposition,
  type MappingSetDetailView,
  type MappingSetSummaryView,
  type MappingValidationIssue,
} from './mapping-admin.domain.js';
import {
  MappingAdminServiceError,
  RequisitionLifecycleMappingAdminService,
} from './requisition-lifecycle-mapping-admin.service.js';

// L1-D3-A — VMS Lifecycle Mapping Administration API. A tenant-scoped sub-resource
// of the integration connection (Settings → Integrations → Connection → Lifecycle
// Mapping). Reuses the integration guard chain + scopes; tenant_id ALWAYS from the
// AuthContext; a cross-tenant / unknown connection or version conceals as 404.
//
// The body is validated EXPLICITLY here (boundary #1): only the four external
// actions are authorable for EXECUTE_ACTION, IGNORE forbids an action, there is no
// authority_mode field (DUAL_CONTROL unauthorable — R5), and unknown keys (a raw
// target_status — DoD #15) are rejected. The service (boundary #2) and DB CHECK
// (boundary #3) re-enforce.
@Controller('v1/integrations/:connectionId/requisition-lifecycle-mappings')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class RequisitionLifecycleMappingAdminController {
  constructor(private readonly service: RequisitionLifecycleMappingAdminService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @RequestId() requestId: string,
  ): Promise<{ items: MappingSetSummaryView[] }> {
    const items = await this.guard(requestId, () =>
      this.service.listSets(authContext.tenant_id, connectionId),
    );
    return { items };
  }

  @Get('active')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async active(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @RequestId() requestId: string,
  ): Promise<MappingSetDetailView> {
    return this.guard(requestId, () =>
      this.service.getActiveSet(authContext.tenant_id, connectionId),
    );
  }

  @Get('versions/:version')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async getVersion(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @Param('version') version: string,
    @RequestId() requestId: string,
  ): Promise<MappingSetDetailView> {
    const v = this.parseVersion(version, requestId);
    return this.guard(requestId, () => this.service.getSet(authContext.tenant_id, connectionId, v));
  }

  @Post('versions')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('integration:write')
  async createDraft(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @Body() body: MappingSetRowsRequest,
    @RequestId() requestId: string,
  ): Promise<MappingSetDetailView> {
    const rows = this.parseRows(body, requestId);
    return this.guard(requestId, () =>
      this.service.createDraft(authContext.tenant_id, connectionId, authContext.sub, rows),
    );
  }

  @Put('versions/:version')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async replaceDraft(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @Param('version') version: string,
    @Body() body: MappingSetRowsRequest,
    @RequestId() requestId: string,
  ): Promise<MappingSetDetailView> {
    const v = this.parseVersion(version, requestId);
    const rows = this.parseRows(body, requestId);
    return this.guard(requestId, () =>
      this.service.replaceDraftRows(authContext.tenant_id, connectionId, v, authContext.sub, rows),
    );
  }

  @Post('versions/:version/validate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async validate(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @Param('version') version: string,
    @RequestId() requestId: string,
  ): Promise<{ issues: MappingValidationIssue[] }> {
    const v = this.parseVersion(version, requestId);
    const issues = await this.guard(requestId, () =>
      this.service.validateSet(authContext.tenant_id, connectionId, v),
    );
    return { issues };
  }

  @Post('versions/:version/activate')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async activate(
    @AuthContext() authContext: AuthContextType,
    @Param('connectionId') connectionId: string,
    @Param('version') version: string,
    @RequestId() requestId: string,
  ): Promise<MappingSetDetailView> {
    const v = this.parseVersion(version, requestId);
    return this.guard(requestId, () =>
      this.service.activateSet(authContext.tenant_id, connectionId, v, authContext.sub),
    );
  }

  // -------------------------------------------------------------------------
  // Validation + error mapping
  // -------------------------------------------------------------------------

  private parseVersion(raw: string, requestId: string): number {
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 1) {
      throw new AramoError('VALIDATION_ERROR', 'version must be a positive integer', 400, {
        requestId,
        details: { field: 'version' },
      });
    }
    return v;
  }

  /** Explicit body validation (R4 boundary #1). Rejects unknown keys (target_status),
   * enforces the disposition/action legality, and forbids an authority_mode field. */
  private parseRows(body: MappingSetRowsRequest, requestId: string): DraftMappingRowInput[] {
    const fail = (message: string, details?: Record<string, unknown>): never => {
      throw new AramoError('VALIDATION_ERROR', message, 400, { requestId, details });
    };
    if (typeof body !== 'object' || body === null || !Array.isArray(body.rows)) {
      return fail('body.rows must be an array');
    }
    const allowedKeys = new Set(['provider_state', 'disposition', 'mapped_action']);
    return body.rows.map((row: MappingRowRequest, index): DraftMappingRowInput => {
      if (typeof row !== 'object' || row === null) {
        return fail(`rows[${index}] must be an object`, { index });
      }
      for (const key of Object.keys(row)) {
        if (!allowedKeys.has(key)) {
          // Rejects a raw target_status / status / authority_mode field outright.
          return fail(`rows[${index}] has an unsupported field '${key}'`, { index, field: key });
        }
      }
      if (typeof row.provider_state !== 'string' || row.provider_state.trim().length === 0) {
        return fail(`rows[${index}].provider_state must be a non-empty string`, { index });
      }
      const disposition = row.disposition;
      if (disposition === MAPPING_DISPOSITION.EXECUTE_ACTION) {
        if (typeof row.mapped_action !== 'string' || !isMappingAdminAllowedAction(row.mapped_action)) {
          return fail(
            `rows[${index}].mapped_action must be one of the four external actions for EXECUTE_ACTION`,
            { index },
          );
        }
        return {
          provider_state: row.provider_state,
          disposition: MAPPING_DISPOSITION.EXECUTE_ACTION,
          mapped_action: row.mapped_action,
        };
      }
      if (disposition === MAPPING_DISPOSITION.IGNORE) {
        if (row.mapped_action !== undefined && row.mapped_action !== null) {
          return fail(`rows[${index}] IGNORE must not carry a mapped_action`, { index });
        }
        return { provider_state: row.provider_state, disposition: MAPPING_DISPOSITION.IGNORE };
      }
      return fail(`rows[${index}].disposition must be EXECUTE_ACTION or IGNORE`, { index });
    });
  }

  /** Map typed MappingAdminServiceError → deterministic tenant-safe HTTP AramoError. */
  private async guard<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MappingAdminServiceError) {
        switch (err.code) {
          case 'CONNECTION_NOT_FOUND':
            throw new AramoError('NOT_FOUND', 'Integration connection not found in tenant', 404, {
              requestId,
            });
          case 'MAPPING_SET_NOT_FOUND':
          case 'NO_ACTIVE_MAPPING_SET':
            throw new AramoError('NOT_FOUND', err.message, 404, { requestId });
          case 'MAPPING_SET_NOT_DRAFT':
          case 'ACTIVE_SET_CONFLICT':
            throw new AramoError('CONNECTOR_CONFIGURATION_INVALID', err.message, 409, {
              requestId,
              details: { code: err.code },
            });
          case 'MAPPING_SET_INVALID':
            throw new AramoError('VALIDATION_ERROR', err.message, 422, {
              requestId,
              details: { code: err.code, issues: err.issues ?? [] },
            });
          default:
            throw err;
        }
      }
      throw err;
    }
  }
}
