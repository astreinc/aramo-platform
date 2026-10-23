import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import {
  DossierService,
  type DossierHead,
  type DossierEvidencePage,
} from './dossier.service.js';

// TR-14 B2 → ATI-SEP-1 T10 WP3b — the recruiter trust dossier, now a read-only
// presentation of Talent Intelligence's tenant view of this record (TI owns
// trust). Gated exactly as the record detail it belongs to: capability `ats` +
// scope `talent:read`. ENRICHMENT ONLY — when TI is not configured, the tenant
// is not entitled, or TI is down the head is ledger_established:false with
// intelligence_status saying why (200, never an error). A 404 means the id is not
// a UUID (ParseUUIDPipe). The contradiction KEEP / RETRACT action lives on the
// separate `identity:resolve` surface (ContradictionResolutionController).
@Controller('v1/talent-records/:id/dossier')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class DossierController {
  constructor(private readonly dossier: DossierService) {}

  @Get()
  @RequireScopes('talent:read')
  async head(
    @AuthContext() authContext: AuthContextType,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<DossierHead> {
    return this.dossier.getDossier(authContext.tenant_id, id);
  }

  @Get('evidence')
  @RequireScopes('talent:read')
  async evidence(
    @AuthContext() authContext: AuthContextType,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<DossierEvidencePage> {
    const parsedLimit = limit !== undefined ? Number.parseInt(limit, 10) : undefined;
    return this.dossier.getDossierEvidence(authContext.tenant_id, id, {
      cursor: cursor ?? null,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
  }
}
