import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import {
  DossierService,
  type DossierHead,
  type DossierEvidencePage,
} from './dossier.service.js';

// TR-14 B2 (DDR §2.1/§2.5) — the contracted trust dossier: the Trust Assessment
// form, read-only, per TalentRecord. Record-side entry (the ATS_TALENT_RECORD
// reverse lookup → fixpoint → cluster-union). Gated exactly as the record detail
// it belongs to: capability `ats` + scope `talent:read` (viewing a record's trust
// IS reading the record — trust is core to the record under ATS-as-Heart; no
// dedicated trust-read scope exists). The contradiction RESOLVE action lives on
// the separate `identity:resolve` surface (TR-4), wired from the tab's dialog.
//
// A record with no subject returns the uniform ledger_established:false head, not
// a 404 — the honest "no evidence ledger yet" state. A 404 means the id is not a
// UUID (ParseUUIDPipe) — record existence is the ledger's concern, not this read's.
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
