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
import { TalentTrustService } from '@aramo/talent-trust';

import { ResolveContradictionDto } from './dto/contradiction-resolution.dto.js';

// TR-4 B3 (§3.3) — the PRIVILEGED resolve-contradiction surface. The consistency
// detectors (and the promotion-reconcile detector) RAISE contradictions; a human
// RESOLVES them here — the one human arm on the contradiction machinery. Lives in
// apps/api (above the I15 wall) and calls the cip TalentTrustService.
//
// Resolving a contradiction is a trust-model action, not recruiter self-serve:
// same privileged, tenant-scoped `identity:resolve` scope as the advisory merge
// surface (tenant_admin + tenant_owner). actor comes ONLY from the JWT (R4 audit).
// Refusals are domain-coded: an unknown evidence id → 404; a not-CONTRADICTED
// record → 422 EVIDENCE_NOT_CONTRADICTED. No FE this slice (TR-14 owns the UI).
@Controller('v1/talent/identity/contradictions')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class ContradictionResolutionController {
  constructor(private readonly trust: TalentTrustService) {}

  @Post(':evidenceId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async resolve(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() body: ResolveContradictionDto,
  ): Promise<{ status: 'RESOLVED'; evidence_id: string }> {
    // Flips CONTRADICTED → VALID via the CONTRADICTION_RESOLVED arm; recompute
    // fires and the CORROBORATED cap lifts. Throws NotFoundException (→404) for an
    // unknown id, or AramoError EVIDENCE_NOT_CONTRADICTED (422) for a non-standing
    // contradiction — the requestId threads into that envelope.
    await this.trust.resolveContradiction(evidenceId, authContext.sub, body.reason, requestId);
    return { status: 'RESOLVED', evidence_id: evidenceId };
  }
}
