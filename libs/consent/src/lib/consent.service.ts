import { Injectable } from '@nestjs/common';
import { hashCanonicalizedBody } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { ConsentRepository } from './consent.repository.js';
import type { ConsentCheckRequestDto } from './dto/consent-check-request.dto.js';
import type { ConsentDecisionDto } from './dto/consent-decision.dto.js';
import type { ConsentGrantRequestDto } from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';
import type { ConsentRevokeRequestDto } from './dto/consent-revoke-request.dto.js';
import type { ConsentRevokeResponseDto } from './dto/consent-revoke-response.dto.js';

// Service trusts the controller boundary's class-validator pass.
// Tenant id and (when applicable) actor id come from the JWT, not the body.
@Injectable()
export class ConsentService {
  constructor(private readonly consentRepo: ConsentRepository) {}

  async grant(
    request: ConsentGrantRequestDto,
    idempotencyKey: string,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentGrantResponseDto> {
    return this.consentRepo.recordConsentEvent({
      action: 'granted',
      tenant_id: authContext.tenant_id,
      talent_id: request.talent_id,
      scope: request.scope,
      captured_method: request.captured_method,
      captured_by_actor_id: this.deriveActorId(authContext),
      consent_version: request.consent_version,
      consent_text_snapshot: request.consent_text_snapshot,
      consent_document_id: request.consent_document_id,
      occurred_at: request.occurred_at,
      expires_at: request.expires_at,
      metadata: request.metadata,
      idempotencyKey,
      requestHash: hashCanonicalizedBody(request),
      requestId,
    });
  }

  async revoke(
    request: ConsentRevokeRequestDto,
    idempotencyKey: string,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentRevokeResponseDto> {
    return this.consentRepo.recordConsentEvent({
      action: 'revoked',
      tenant_id: authContext.tenant_id,
      talent_id: request.talent_id,
      scope: request.scope,
      captured_method: request.captured_method,
      captured_by_actor_id: this.deriveActorId(authContext),
      consent_version: request.consent_version,
      // No expires_at, no consent_text_snapshot — grant-only fields.
      consent_document_id: request.consent_document_id,
      occurred_at: request.occurred_at,
      metadata: request.metadata,
      idempotencyKey,
      requestHash: hashCanonicalizedBody(request),
      requestId,
    });
  }

  /**
   * Runtime consent check (PR-4). Idempotency-Key is OPTIONAL per Phase 1
   * §6: when present + same body matches a prior call, the original
   * ConsentDecision is returned from the idempotency table without
   * re-running the resolver or emitting a new decision-log entry. Same
   * key + different body returns 409 IDEMPOTENCY_KEY_CONFLICT. When
   * absent, every call runs the resolver and writes a fresh decision-log
   * entry (Decision H).
   */
  async check(
    request: ConsentCheckRequestDto,
    idempotencyKey: string | undefined,
    authContext: AuthContextType,
    requestId: string,
  ): Promise<ConsentDecisionDto> {
    return this.consentRepo.resolveConsentState({
      tenant_id: authContext.tenant_id,
      talent_id: request.talent_id,
      operation: request.operation,
      channel: request.channel,
      idempotencyKey,
      requestHash: hashCanonicalizedBody(request),
      requestId,
    });
  }

  private deriveActorId(authContext: AuthContextType): string | null {
    return authContext.consumer_type === 'recruiter' ? authContext.sub : null;
  }
}
