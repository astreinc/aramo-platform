import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { ExportEntityPathDto, ExportQueryDto } from './dto/export-entity-type.js';
import { ExportService } from './export.service.js';
import { EXPORT_ENTITY_TYPES, type ExportEntityType } from './field-catalog.js';

// PR-A8-4 — ATS-domain CSV export controller.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes('export:read')       // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// Scope (NOT seeded — gap-and-note per A7's `report:read` precedent):
//   - `export:read` — read-only (recruiter+ AND tenant_admin; the
//     A3-visibility predicate at the service layer governs what each
//     role exports, NOT a separate `:all` scope here — the existing
//     `requisition:read:all` is what flips tenant_admin to tenant-wide).
//
// The R10 boundary is documented in ExportService — the service
// reads ONLY the 5 ATS-domain repositories, and the lint:nx-boundaries
// graph for libs/export records ZERO Core / engagement / submittal /
// examination / talent / job_domain edges.
//
// The OUTBOUND-VOCABULARY rule: response headers carry the canonical
// Aramo ATS field names; outbound-anti-tokens NEVER appear in the
// export header row — the inbound alias is import-only (see the
// integration spec OUTBOUND_ANTI_TOKENS list).

const COLUMNS_DELIMITER = ',';
const MAX_COLUMNS_PER_REQUEST = 100;

@Controller('v1/exports')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  // GET /v1/exports/:entity_type
  //   ?columns=name,city,zip   (optional — default: all ATS columns)
  //   ?site_id=<uuid>          (optional — RequireSiteMatch enforces match)
  //   ?limit=<int>             (optional — default 5000, max 10000)
  //
  // Returns text/csv with the canonical ATS field-name header row.
  // 200 → CSV body; the controller sets Content-Type + Content-
  // Disposition so a browser download is named exports-<entity>.csv.
  @Get(':entity_type')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('export:read')
  @RequireSiteMatch()
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportEntity(
    @Param() params: ExportEntityPathDto,
    @Query() query: ExportQueryDto,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<string> {
    // entity_type — validated by class-validator (@IsIn). Belt-and-
    // braces re-narrow here so the switch in the service is exhaustive.
    if (!EXPORT_ENTITY_TYPES.includes(params.entity_type)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `Unknown entity_type: ${params.entity_type}`,
        400,
        {
          requestId,
          details: {
            entity_type: params.entity_type,
            allowed: EXPORT_ENTITY_TYPES,
          },
        },
      );
    }

    const columns = parseColumns(query.columns, requestId);
    const limit = parseLimit(query.limit, requestId);

    const visibility = await req.resolveVisibility!();
    return this.exportService.exportEntity({
      entity_type: params.entity_type as ExportEntityType,
      ...(columns === undefined ? {} : { columns }),
      ...(limit === undefined ? {} : { limit }),
      actor: {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        scopes: authContext.scopes,
        visibility,
        ...(query.site_id === undefined ? {} : { site_id: query.site_id }),
      },
      requestId,
    });
  }
}

function parseColumns(
  raw: string | undefined,
  requestId: string,
): readonly string[] | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  const parts = raw
    .split(COLUMNS_DELIMITER)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  if (parts.length > MAX_COLUMNS_PER_REQUEST) {
    throw new AramoError(
      'VALIDATION_ERROR',
      `Too many columns requested (got ${parts.length}, max ${MAX_COLUMNS_PER_REQUEST})`,
      400,
      { requestId, details: { count: parts.length, max: MAX_COLUMNS_PER_REQUEST } },
    );
  }
  return parts;
}

function parseLimit(raw: string | undefined, requestId: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AramoError(
      'VALIDATION_ERROR',
      `Invalid limit: ${raw}`,
      400,
      { requestId, details: { limit: raw } },
    );
  }
  return n;
}
