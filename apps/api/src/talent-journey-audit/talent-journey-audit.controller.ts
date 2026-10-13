import { Controller, Get, HttpCode, HttpStatus, Param, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { TalentJourneyAuditService } from './talent-journey-audit.service.js';
import type { TalentJourneyAuditView } from './dto/talent-journey-audit.view.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// INC-1e (TIP-E2E) — the correlated journey-audit read surface: a GET sub-resource of
// the submittal. Guard chain mirrors the canonical ATS reads (JwtAuthGuard ->
// EntitlementGuard -> RolesGuard + @RequireCapability('ats')), recruiter-only. The
// tenant + requisition-visibility concealment is enforced in the service (a non-visible
// / cross-tenant submittal resolves to 404, never 403 — existence is not disclosed). No
// NEW scope is minted: this is a visibility-concealed read exactly like GET
// /v1/submittals/:id, so it carries no D-SEED-SCOPES-1 catalog change.
@Controller('v1/submittals')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class TalentJourneyAuditController {
  constructor(private readonly audit: TalentJourneyAuditService) {}

  @Get(':submittal_id/journey-audit')
  @HttpCode(HttpStatus.OK)
  async getJourneyAudit(
    @Param('submittal_id') submittal_id: string,
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<TalentJourneyAuditView> {
    if (authContext.consumer_type !== 'recruiter') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'journey-audit is recruiter-only', 403, {
        requestId,
        details: { consumer_type: authContext.consumer_type },
      });
    }
    if (!UUID_REGEX.test(submittal_id)) {
      throw new AramoError('INVALID_REQUEST', 'submittal_id must be a UUID', 400, {
        requestId,
        details: { field: 'submittal_id' },
      });
    }
    // The pre-resolved AUTHZ visible-requisition set (null = see_all). The service
    // conceals a non-visible / cross-tenant submittal as 404.
    const visible_requisition_ids = await req.resolveVisibleRequisitionIds!();
    return this.audit.getAuditTrace({
      tenant_id: authContext.tenant_id,
      submittal_id,
      visible_requisition_ids,
      requestId,
    });
  }
}
