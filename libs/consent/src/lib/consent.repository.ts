import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import type {
  ConsentCapturedMethodValue,
  ConsentScopeValue,
} from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

export interface RecordGrantEventInput {
  tenant_id: string;
  talent_id: string;
  scope: ConsentScopeValue;
  captured_method: ConsentCapturedMethodValue;
  captured_by_actor_id: string | null;
  consent_version: string;
  consent_text_snapshot?: string;
  consent_document_id?: string;
  occurred_at: string;
  expires_at?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
}

// PR-2 precedent #6: transaction boundary lives in the repository.
// PR-2 precedent #4: no update method — the immutable ledger is enforced
// here (no method exposed) AND in the database (BEFORE UPDATE trigger).
@Injectable()
export class ConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordGrantEvent(input: RecordGrantEventInput): Promise<ConsentGrantResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      // 1. Idempotency check
      const existing = await tx.idempotencyKey.findUnique({
        where: {
          tenant_id_key: {
            tenant_id: input.tenant_id,
            key: input.idempotencyKey,
          },
        },
      });
      if (existing !== null) {
        if (existing.request_hash !== input.requestHash) {
          throw new AramoError(
            'IDEMPOTENCY_KEY_CONFLICT',
            'Same idempotency key used with a different request body',
            409,
            { requestId: input.requestId },
          );
        }
        return existing.response_body as unknown as ConsentGrantResponseDto;
      }

      // 2. Insert TalentConsentEvent (action set server-side per PR-2 #16)
      const eventId = uuidv7();
      const occurredAt = new Date(input.occurred_at);
      const expiresAt =
        input.expires_at !== undefined ? new Date(input.expires_at) : null;
      const event = await tx.talentConsentEvent.create({
        data: {
          id: eventId,
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
          scope: input.scope,
          action: 'granted',
          captured_by_actor_id: input.captured_by_actor_id,
          captured_method: input.captured_method,
          consent_version: input.consent_version,
          consent_text_snapshot: input.consent_text_snapshot ?? null,
          consent_document_id: input.consent_document_id ?? null,
          occurred_at: occurredAt,
          expires_at: expiresAt,
          metadata: (input.metadata ?? null) as never,
        },
      });

      // 3. Insert ConsentAuditEvent (separate "audit" schema, same tx)
      await tx.consentAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          actor_id: input.captured_by_actor_id,
          actor_type:
            input.captured_method === 'self_signup' ? 'self' : 'recruiter',
          event_type: 'consent.grant.recorded',
          subject_id: input.talent_id,
          event_payload: {
            event_id: eventId,
            scope: input.scope,
          },
        },
      });

      // 4. Insert OutboxEvent (per Architecture v2.0 §7.6)
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: 'consent.granted',
          event_payload: {
            event_id: eventId,
            talent_id: input.talent_id,
            scope: input.scope,
          },
        },
      });

      const response: ConsentGrantResponseDto = {
        event_id: eventId,
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        scope: input.scope,
        action: 'granted',
        captured_method: input.captured_method,
        ...(input.captured_by_actor_id !== null && {
          captured_by_actor_id: input.captured_by_actor_id,
        }),
        consent_version: input.consent_version,
        ...(input.consent_document_id !== undefined && {
          consent_document_id: input.consent_document_id,
        }),
        occurred_at: occurredAt.toISOString(),
        ...(expiresAt !== null && { expires_at: expiresAt.toISOString() }),
        recorded_at: event.created_at.toISOString(),
        ...(input.metadata !== undefined && { metadata: input.metadata }),
      };

      // 5. Persist idempotency record so future replays return identical body
      await tx.idempotencyKey.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          key: input.idempotencyKey,
          request_hash: input.requestHash,
          response_status: 201,
          response_body: response as never,
        },
      });

      return response;
    });
  }
}
