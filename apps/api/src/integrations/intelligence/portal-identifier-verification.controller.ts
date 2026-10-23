import { Body, Controller, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { AramoError, RequestId } from '@aramo/common';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  IdentifierSlotEmptyError,
  IntelligenceNotConfiguredError,
  IntelligenceRejectedError,
  IntelligenceUnavailableError,
  IntelligenceVerificationDisabledError,
  IntelligenceVerificationService,
} from '@aramo/intelligence-integration';
import { PortalTalentResolverService } from '@aramo/portal';

import { ConfirmIdentifierVerificationDto, RequestIdentifierVerificationDto } from './portal-identifier-verification.dto.js';

// ATI-SEP-1 T8 (ADR-0036 §5 "Verification v1: a talent email OTP, initiated
// through the portal and executed by TI").
//
//   POST /v1/portal/records/:id/identifier-verifications                 { slot }
//   POST /v1/portal/records/:id/identifier-verifications/:vid/confirm    { code }
//
// Portal session only (consumer portal, sub = PortalUser.id); membership of the
// record is proven through the OPEN-4 chain — an unknown / not-yours record is a
// UNIFORM 404. GATED behind INTELLIGENCE_VERIFICATION_ENABLED=true (default
// false) + a configured TI client + the record tenant's `intelligence`
// capability; when the gate is closed the routes answer the same uniform 404
// (the feature does not exist for this caller). The legacy trust email
// verification is untouched until T10.
//
// The code is relayed to TI and never logged or stored here. The verification
// id is unguessable (UUID) and the code reaches only the mailbox owner; TI
// enforces the TTL and the attempt budget (5) and locks after it.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/portal/records/:id/identifier-verifications')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('portal')
export class PortalIdentifierVerificationController {
  constructor(
    private readonly resolver: PortalTalentResolverService,
    private readonly verifications: IntelligenceVerificationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('portal:profile:edit')
  async request(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Body() body: RequestIdentifierVerificationDto,
  ): Promise<{ verification_id: string; status: 'PENDING'; expires_at: string; delivery: 'QUEUED' | 'NOT_AVAILABLE' }> {
    const member = await this.member(authContext, id, requestId);
    try {
      const r = await this.verifications.request({ tenant_id: member.tenant_id, talent_record_id: member.record_id, slot: body.slot });
      if (r === null) throw notFound(requestId);
      return { verification_id: r.verification_id, status: r.status, expires_at: r.expires_at, delivery: r.delivery };
    } catch (err) {
      throw mapError(err, requestId);
    }
  }

  @Post(':verificationId/confirm')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('portal:profile:edit')
  async confirm(
    @AuthContext() authContext: AuthContextType,
    @RequestId() requestId: string,
    @Param('id') id: string,
    @Param('verificationId') verificationId: string,
    @Body() body: ConfirmIdentifierVerificationDto,
  ): Promise<{ verification_id: string; status: 'CONFIRMED'; outcome: string }> {
    const member = await this.member(authContext, id, requestId);
    if (!UUID_REGEX.test(verificationId)) throw notFound(requestId);
    try {
      const r = await this.verifications.confirm({ tenant_id: member.tenant_id, verification_id: verificationId, code: body.code });
      return { verification_id: r.verification_id, status: r.status, outcome: r.outcome };
    } catch (err) {
      throw mapError(err, requestId);
    }
  }

  private async member(authContext: AuthContextType, recordId: string, requestId: string): Promise<{ tenant_id: string; record_id: string }> {
    if (authContext.consumer_type !== 'portal') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'portal endpoints are portal-consumer only', 403, {
        requestId,
        details: { consumer_type: authContext.consumer_type },
      });
    }
    if (!UUID_REGEX.test(authContext.sub)) {
      throw new AramoError('INVALID_REQUEST', 'portal token sub claim must be a UUID', 400, { requestId, details: { invalid_field: 'sub' } });
    }
    if (!UUID_REGEX.test(recordId)) throw notFound(requestId);
    const member = await this.resolver.resolveMemberRecord(authContext.sub, recordId);
    if (member === null) throw notFound(requestId);
    return member;
  }
}

function notFound(requestId: string): AramoError {
  // ATI-SEP-1 A4 (GAP-PORTAL-ID-1) — the SAME uniform 404 NOT_AVAILABLE shape as
  // libs/portal's PortalController (the portal resolver resolves no talent).
  return new AramoError('NOT_FOUND', 'not available', 404, {
    requestId,
    details: { reason: 'NOT_AVAILABLE' },
  });
}

function mapError(err: unknown, requestId: string): unknown {
  if (err instanceof AramoError) return err;
  if (err instanceof IntelligenceVerificationDisabledError) return notFound(requestId);
  if (err instanceof IdentifierSlotEmptyError) {
    return new AramoError('VALIDATION_ERROR', 'the named email slot holds no address', 400, {
      requestId,
      details: { slot: err.slot, reason: 'email_slot_empty' },
    });
  }
  if (err instanceof IntelligenceRejectedError) {
    if (err.status === 404) return notFound(requestId);
    return new AramoError('IDENTIFIER_VERIFICATION_REFUSED', 'the verification was refused', 422, {
      requestId,
      details: {
        reason: err.code,
        ...(typeof err.details['attempts_remaining'] === 'number' ? { attempts_remaining: err.details['attempts_remaining'] } : {}),
      },
    });
  }
  if (err instanceof IntelligenceUnavailableError || err instanceof IntelligenceNotConfiguredError) {
    return new AramoError('INTELLIGENCE_UNAVAILABLE', 'Talent Intelligence is unavailable', 503, { requestId });
  }
  return err;
}
