import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { v7 as uuidv7 } from 'uuid';

import type {
  ConsentCapturedMethodValue,
  ConsentScopeValue,
} from './dto/consent-grant-request.dto.js';
import type { ConsentGrantResponseDto } from './dto/consent-grant-response.dto.js';
import type { ConsentRevokeResponseDto } from './dto/consent-revoke-response.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

export type ConsentActionValue = 'granted' | 'revoked';

export interface RecordConsentEventInput {
  tenant_id: string;
  talent_id: string;
  action: ConsentActionValue;
  scope: ConsentScopeValue;
  captured_method: ConsentCapturedMethodValue;
  captured_by_actor_id: string | null;
  consent_version: string;
  // grant-only field; revoke ignores
  consent_text_snapshot?: string;
  consent_document_id?: string;
  occurred_at: string;
  // grant-only field; revoke ignores
  expires_at?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey: string;
  requestHash: string;
  requestId: string;
}

// Conditional return type: the public API discriminates the response
// shape from the input action, so service callers don't need to cast.
// A future DTO field change that breaks the contract surfaces as a
// type error at the call site, not as a runtime drift.
export type ConsentEventResponseShape<T extends ConsentActionValue> =
  T extends 'granted'
    ? ConsentGrantResponseDto
    : T extends 'revoked'
      ? ConsentRevokeResponseDto
      : never;

// Single-event lookup is the only cross-event query allowed in this repo
// per ADR-0005 (pending) Decision E refinement: "no cross-event consent
// state derivation; single-event lookups for referential linkage are
// allowed". Used here to populate revoked_event_id (Decision A).

// PR-2 precedent #6: transaction boundary lives in the repository.
// PR-2 precedent #4: no update method — the immutable ledger is enforced
// here (no method exposed) AND in the database (BEFORE UPDATE trigger).
@Injectable()
export class ConsentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async recordConsentEvent<T extends ConsentActionValue>(
    input: RecordConsentEventInput & { action: T },
  ): Promise<ConsentEventResponseShape<T>> {
    // Defense-in-depth: refuse any action value not in the locked set.
    // Belt-and-suspenders alongside the OpenAPI schema validation
    // (additionalProperties: false), the class-validator pipe
    // (forbidNonWhitelisted: true), and the service layer's hardcoded
    // literals. Matches the R8 / R9 idiom where Charter refusals are
    // enforced at multiple layers, not relying on type safety alone.
    if (input.action !== 'granted' && input.action !== 'revoked') {
      throw new AramoError(
        'INTERNAL_ERROR',
        `recordConsentEvent received an unsupported action: ${String(input.action)}`,
        500,
        {
          requestId: input.requestId,
          details: { received_action: String(input.action) },
        },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Idempotency check (unchanged from PR-2)
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
        // Internal cast: the persisted JSON body is the discriminated
        // shape we wrote on the original call; the runtime guarantee
        // is provided by the Decision A/D contract (revoke records
        // always carry revoked_event_id; grant records never do).
        return existing.response_body as unknown as ConsentEventResponseShape<T>;
      }

      // 2. For revoked, perform single-event lookup BEFORE the writes
      //    (Decision A). Lookup runs inside the same transaction; if it
      //    fails the whole tx aborts before any write (preserves R13).
      let revokedEventId: string | null = null;
      if (input.action === 'revoked') {
        const priorGrant = await tx.talentConsentEvent.findFirst({
          where: {
            tenant_id: input.tenant_id,
            talent_id: input.talent_id,
            scope: input.scope,
            action: 'granted',
          },
          orderBy: { occurred_at: 'desc' },
          select: { id: true },
        });
        revokedEventId = priorGrant?.id ?? null;
      }

      // 3. Insert TalentConsentEvent (action set server-side per PR-2 #16)
      const eventId = uuidv7();
      const occurredAt = new Date(input.occurred_at);
      const isGrant = input.action === 'granted';
      const expiresAt =
        isGrant && input.expires_at !== undefined
          ? new Date(input.expires_at)
          : null;
      const event = await tx.talentConsentEvent.create({
        data: {
          id: eventId,
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
          scope: input.scope,
          action: input.action,
          captured_by_actor_id: input.captured_by_actor_id,
          captured_method: input.captured_method,
          consent_version: input.consent_version,
          consent_text_snapshot:
            isGrant && input.consent_text_snapshot !== undefined
              ? input.consent_text_snapshot
              : null,
          consent_document_id: input.consent_document_id ?? null,
          occurred_at: occurredAt,
          expires_at: expiresAt,
          metadata: (input.metadata ?? null) as never,
        },
      });

      // 4. Insert ConsentAuditEvent. Action-specific event_payload:
      //    granted → { event_id, scope }
      //    revoked → §2.7 canonical audit structure (Decisions A/B/C)
      const auditPayload = isGrant
        ? { event_id: eventId, scope: input.scope }
        : {
            event_id: eventId,
            scope: input.scope,
            revoked_event_id: revokedEventId,         // Decision A
            in_flight_operations_halted: [],          // Decision B
            propagation_completed_at: null,           // Decision C
          };
      await tx.consentAuditEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          actor_id: input.captured_by_actor_id,
          actor_type:
            input.captured_method === 'self_signup' ? 'self' : 'recruiter',
          event_type: isGrant
            ? 'consent.grant.recorded'
            : 'consent.revoke.recorded',
          subject_id: input.talent_id,
          event_payload: auditPayload as never,
        },
      });

      // 5. Insert OutboxEvent (per Architecture v2.0 §7.6)
      const outboxPayload = isGrant
        ? {
            event_id: eventId,
            talent_id: input.talent_id,
            scope: input.scope,
          }
        : {
            event_id: eventId,
            talent_id: input.talent_id,
            scope: input.scope,
            revoked_event_id: revokedEventId,
          };
      await tx.outboxEvent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          event_type: isGrant ? 'consent.granted' : 'consent.revoked',
          event_payload: outboxPayload as never,
        },
      });

      // 6. Build response. The conditional return type discriminates
      //    by T at call sites; here in the implementation we build the
      //    union and cast once at the return statement.
      const response: ConsentGrantResponseDto | ConsentRevokeResponseDto =
        isGrant
          ? ({
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
            } satisfies ConsentGrantResponseDto)
          : ({
              event_id: eventId,
              tenant_id: input.tenant_id,
              talent_id: input.talent_id,
              scope: input.scope,
              action: 'revoked',
              captured_method: input.captured_method,
              ...(input.captured_by_actor_id !== null && {
                captured_by_actor_id: input.captured_by_actor_id,
              }),
              consent_version: input.consent_version,
              ...(input.consent_document_id !== undefined && {
                consent_document_id: input.consent_document_id,
              }),
              occurred_at: occurredAt.toISOString(),
              recorded_at: event.created_at.toISOString(),
              revoked_event_id: revokedEventId,            // Decision A/D
              ...(input.metadata !== undefined && { metadata: input.metadata }),
            } satisfies ConsentRevokeResponseDto);

      // 7. Persist idempotency record so future replays return identical body
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

      // Single internal cast to the conditional public type. The branch
      // above guarantees grant→ConsentGrantResponseDto and
      // revoked→ConsentRevokeResponseDto; the public type signature
      // re-discriminates for callers.
      return response as ConsentEventResponseShape<T>;
    });
  }
}
