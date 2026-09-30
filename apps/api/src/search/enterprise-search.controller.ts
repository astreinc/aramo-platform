import { Controller, Get, HttpCode, HttpStatus, Inject, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import {
  ENTERPRISE_SEARCH_PORT,
  SEARCH_ENTITY_TYPES,
  type EnterpriseSearchPort,
  type SearchEntityType,
  type SearchResults,
} from './enterprise-search.port.js';

// Enterprise Search (GS-1) — the single tenant-safe search entry point (directive §8). The
// guard chain is the ATS pattern (tenant → capability → RolesGuard); there is intentionally
// NO route-level @RequireScopes — search is "find what you're authorized to see", so per-entity
// authorization is enforced INSIDE the orchestrator against each entity's <domain>:search scope
// (RolesGuard still runs: it establishes auth context and would enforce site match if declared).
// The controller resolves visibility via the interceptor seam and passes it as already-resolved
// authority — it computes no visibility of its own.
@Controller('v1/search')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class EnterpriseSearchController {
  constructor(@Inject(ENTERPRISE_SEARCH_PORT) private readonly search: EnterpriseSearchPort) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async searchAll(
    @AuthContext() authContext: AuthContextType,
    @Query('q') q: string | undefined,
    // Comma-separated entity scope for module search (e.g. `TALENT`). Absent = global.
    @Query('entity_types') entityTypes: string | undefined,
    @Query('limit') limit: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<SearchResults> {
    const visibility = await req.resolveVisibility!();
    return this.search.search({
      query: q ?? '',
      entity_types: parseEntityTypes(entityTypes),
      authority: {
        tenant_id: authContext.tenant_id,
        scopes: authContext.scopes,
        visibility,
      },
      limit_per_type: parseLimit(limit),
      requestId,
    });
  }
}

// Parse the comma-separated entity_types filter, keeping only recognised types. Absent = global
// (undefined); a present-but-unknown value is dropped (never fabricated).
function parseEntityTypes(raw: string | undefined): SearchEntityType[] | undefined {
  if (raw === undefined) return undefined;
  const valid = new Set<string>(SEARCH_ENTITY_TYPES);
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is SearchEntityType => valid.has(s));
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
