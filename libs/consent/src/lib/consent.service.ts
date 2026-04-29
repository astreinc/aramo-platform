import { Injectable } from '@nestjs/common';
import { hashCanonicalizedBody } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';

import { ConsentRepository } from './consent.repository.js';
import type { ConsentGrantRequestDto } from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';

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
    const capturedByActorId =
      authContext.consumer_type === 'recruiter' ? authContext.sub : null;
    return this.consentRepo.recordGrantEvent({
      tenant_id: authContext.tenant_id,
      talent_id: request.talent_id,
      scope: request.scope,
      captured_method: request.captured_method,
      captured_by_actor_id: capturedByActorId,
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
}
