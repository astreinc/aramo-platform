import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { ResolveContradictionDto } from './dto/contradiction-resolution.dto.js';
import { IntelligenceAccess } from './intelligence-access.js';

// TR-4 B3 → ATI-SEP-1 T10 WP3b (Addendum A3 T10-2) — the PRIVILEGED
// resolve-contradiction surface, re-pointed onto Talent Intelligence (M-3):
//
//   POST /v1/talent/identity/contradictions/:assertionId/resolve
//        { talent_record_id, reason, resolution? = KEEP | RETRACT }
//   → TI POST /v1/references/ARAMO_ATS/:tenant/:talent_record_id/assertions/:assertionId/contradiction-resolution
//
// KEEP — the assertion stands (its contradictions in this tenant's view are
// reconciled); RETRACT — the assertion is wrong (only one this tenant
// contributed). The resolution is the tenant's ENRICHMENT decision in TI; it
// never mutates ATS data. Same privileged `identity:resolve` scope as before;
// tenant + actor come ONLY from the JWT. Refusals: unknown / not-yours → 404
// NOT_FOUND; not contradicted → 422 EVIDENCE_NOT_CONTRADICTED; TI not enabled /
// down → 503 INTELLIGENCE_UNAVAILABLE (details.intelligence_status).
@Controller('v1/talent/identity/contradictions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class ContradictionResolutionController {
  constructor(private readonly ti: IntelligenceAccess) {}

  @Post(':assertionId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async resolve(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('assertionId', ParseUUIDPipe) assertionId: string,
    @Body() body: ResolveContradictionDto,
  ): Promise<{ status: 'RESOLVED'; assertion_id: string; resolution: string; assertion_status: string }> {
    const tenant_id = authContext.tenant_id;
    const r = await this.ti.act(tenant_id, requestId, (c) =>
      c.resolveContradiction(
        { tenant_id, talent_id: body.talent_record_id, assertion_id: assertionId },
        { resolution: body.resolution ?? 'KEEP', reason: body.reason, actor: authContext.sub },
      ),
    );
    return { status: 'RESOLVED', assertion_id: r.assertion_id, resolution: r.resolution, assertion_status: r.status };
  }
}
