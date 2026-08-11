import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { ImportBatchView } from './dto/import-batch.view.js';
import type {
  CanonicalRequisitionImportRecord,
  RunRequisitionImportRequestDto,
} from './dto/canonical-requisition-import.dto.js';
import { ImportService } from './import.service.js';

// RequisitionImportController — T8-P2 tenant-facing ADMIN surface for
// provider-neutral canonical requisition ingestion (VMS Integration Directive
// v1.0 §13). Backend/admin only — T8-P3 owns the UI. This surface carries NO
// provider credential/config endpoints; the future T8-CONNECTOR produces the
// canonical records and posts them here.
//
// Guard chain (the A2 three-axis pattern, identical to ImportController):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')      // class-level — tenant axis
//   @RequireScopes(...)            // route-level — scope axis
//   @RequireSiteMatch()            // route-level — site axis
//
// Scopes (Architect ruling §4): requisition:import:read / requisition:import:write
// (distinct from the generic CSV `import:*` family; seeded by this increment).
// tenant_id ALWAYS from AuthContext, never the body.
//
// Reversal (§12): a requisition-import batch is an ordinary ImportBatch
// (target_entity='requisition'); it is reverted through the EXISTING generic
// reversible-import path (POST /v1/imports/:id/revert), reused unchanged. No
// new revert route is added here.
@Controller('v1/requisition-imports')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class RequisitionImportController {
  constructor(private readonly importService: ImportService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:import:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
  ): Promise<{ items: ImportBatchView[] }> {
    const items = await this.importService.listRequisitionImports({
      tenant_id: authContext.tenant_id,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('requisition:import:read')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<ImportBatchView> {
    const view = await this.importService.findRequisitionImportById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      // Tenant-safe: absent OR belonging to another tenant → 404, never disclose.
      throw new AramoError('NOT_FOUND', 'Requisition import not found in tenant', 404, {
        requestId,
        details: { id },
      });
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('requisition:import:write')
  @RequireSiteMatch()
  async run(
    @AuthContext() authContext: AuthContextType,
    @Body() body: RunRequisitionImportRequestDto,
    @RequestId() requestId: string,
  ): Promise<ImportBatchView> {
    // Envelope shape-only validation at the boundary (per-record semantics are
    // validated by the mapper and surface as per-record ImportFailure rows).
    this.assertEnvelope(body, requestId);
    return this.importService.runCanonicalRequisitionImport({
      tenant_id: authContext.tenant_id,
      imported_by_id: authContext.sub,
      input: body,
      scopes: authContext.scopes,
      requestId,
    });
  }

  private assertEnvelope(body: RunRequisitionImportRequestDto, requestId: string): void {
    const reject = (field: string, reason: string): never => {
      throw new AramoError('VALIDATION_ERROR', `Invalid ${field}: ${reason}`, 400, {
        requestId,
        details: { field },
      });
    };
    if (typeof body !== 'object' || body === null) reject('body', 'must be an object');
    if (typeof body.source_label !== 'string' || body.source_label.trim().length === 0) {
      reject('source_label', 'must be a non-empty string');
    }
    if (body.site_id !== undefined && typeof body.site_id !== 'string') {
      reject('site_id', 'must be a string when present');
    }
    if (
      body.status_mapping !== undefined &&
      (typeof body.status_mapping !== 'object' || body.status_mapping === null || Array.isArray(body.status_mapping))
    ) {
      reject('status_mapping', 'must be an object map when present');
    }
    if (!Array.isArray(body.records)) reject('records', 'must be an array');
    if ((body.records as CanonicalRequisitionImportRecord[]).length === 0) {
      reject('records', 'must contain at least one record');
    }
  }
}
