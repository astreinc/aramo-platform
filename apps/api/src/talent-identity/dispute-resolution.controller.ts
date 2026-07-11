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

import {
  RaiseDisputeDto,
  ResolveDisputeDto,
} from './dto/dispute-resolution.dto.js';

// TR-15 B1 (DDR §2) — the PRIVILEGED dispute-management surface: the human arms
// on the DISPUTED axis, the parallel twin of the contradiction resolve surface
// (contradiction-resolution.controller.ts). A recruiter/admin RAISES a dispute
// on a talent's communicated objection and RESOLVES it (rejected → the record
// returns to VALID; upheld → the record is retired, DISPUTE_RESOLVED+REVOKED in
// one transaction). The talent-raised surface is TR-15-B.
//
// Same conventions as its twin: lives in apps/api (above the I15 wall), calls
// the cip TalentTrustService, and is gated by the same privileged, tenant-scoped
// `identity:resolve` scope as the contradiction + advisory-merge surfaces
// (tenant_admin + tenant_owner). actor comes ONLY from the JWT (R4 audit).
// Refusals are domain-coded by the service: unknown evidence id → 404; a
// non-VALID dispute target → 422 EVIDENCE_NOT_DISPUTABLE; a non-DISPUTED resolve
// target → 422 EVIDENCE_NOT_DISPUTED; a bad outcome → 422 DISPUTE_OUTCOME_INVALID.
// No FE this slice (the dossier's timeline shows the events automatically).
@Controller('v1/talent/identity/disputes')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class DisputeResolutionController {
  constructor(private readonly trust: TalentTrustService) {}

  @Post(':evidenceId/raise')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async raise(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() body: RaiseDisputeDto,
  ): Promise<{ status: string; evidence_id: string }> {
    // A repeat raise on an already-DISPUTED record is an idempotent no-op that
    // returns the current status; a non-VALID target throws EVIDENCE_NOT_DISPUTABLE
    // (422). NotFoundException (→404) for an unknown id. requestId threads through.
    const { status } = await this.trust.dispute(
      evidenceId,
      authContext.sub,
      body.grounds,
      requestId,
    );
    return { status, evidence_id: evidenceId };
  }

  @Post(':evidenceId/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('identity:resolve')
  async resolve(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('evidenceId', ParseUUIDPipe) evidenceId: string,
    @Body() body: ResolveDisputeDto,
  ): Promise<{ status: string; evidence_id: string }> {
    // rejected → VALID; upheld → REVOKED (DISPUTE_RESOLVED+REVOKED atomically).
    // EVIDENCE_NOT_DISPUTED (422) for a non-standing dispute; DISPUTE_OUTCOME_INVALID
    // (422) for a bad outcome; NotFoundException (→404) for an unknown id.
    const { status } = await this.trust.resolveDispute(
      evidenceId,
      authContext.sub,
      body.outcome,
      body.justification,
      requestId,
    );
    return { status, evidence_id: evidenceId };
  }
}
