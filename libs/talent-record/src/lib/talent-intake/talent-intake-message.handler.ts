import { Inject, Injectable } from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';
import type { AramoEventEnvelope } from '@aramo/events';
import { TalentExtractionService } from '@aramo/talent-extraction';

import {
  TALENT_INTAKE_EVENT_SOURCE,
  TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT,
} from './talent-intake.constants.js';
import {
  TALENT_INTAKE_PROCESSING_PORT,
  type TalentIntakeProcessingPort,
} from './talent-intake-processing.port.js';

// ADR-0033 — the RUNTIME-NEUTRAL Talent Intake message handler.
//
// Receives ONLY a validated AramoEventEnvelope (the SQS/Lambda adapter owns
// decode + envelope validation). This handler knows nothing of SQS, Lambda,
// receipt handles, or EventBridge. It validates the event SEMANTICALLY, derives
// intake identity, re-validates against authoritative persisted state (the
// envelope is NOT authorization), then runs the EXISTING idempotent CAS
// processing path via the port. The caller maps the outcome to transport
// behaviour (ack / retry / drop).

export type TalentIntakeHandleOutcome =
  // Claimed + processed this delivery.
  | { readonly status: 'processed' }
  // Nothing to do (idempotent no-op, or no authoritative match) — ack, no retry.
  | { readonly status: 'skipped'; readonly reason: string }
  // Transient/infra failure — the caller should retry this record.
  | { readonly status: 'retryable'; readonly reason: string }
  // Permanently invalid for this handler — the caller drops it per the explicit
  // malformed policy (logged), never loops.
  | { readonly status: 'malformed'; readonly reason: string };

@Injectable()
export class TalentIntakeMessageHandler {
  constructor(
    @Inject(TALENT_INTAKE_PROCESSING_PORT)
    private readonly processing: TalentIntakeProcessingPort,
    private readonly talentExtraction: TalentExtractionService,
    @Inject('TalentIntakeMessageHandlerLogger')
    private readonly logger: AramoLogger,
  ) {}

  async handle(envelope: AramoEventEnvelope): Promise<TalentIntakeHandleOutcome> {
    // 1. Supported event type — reject anything else EXPLICITLY (never silently
    //    treat an arbitrary envelope as Talent Intake work).
    if (envelope.event_type !== TALENT_INTAKE_EXTRACTION_REQUESTED_EVENT) {
      return { status: 'malformed', reason: `unsupported_event_type:${envelope.event_type}` };
    }
    if (envelope.source !== TALENT_INTAKE_EVENT_SOURCE) {
      return { status: 'malformed', reason: `unexpected_source:${envelope.source}` };
    }
    const tenantId = envelope.tenant_id;
    const draftId = envelope.subject_id;
    if (tenantId === '' || draftId === '') {
      return { status: 'malformed', reason: 'missing_tenant_or_subject' };
    }

    // 2. Authoritative re-validation. The envelope's tenant_id is routing
    //    context, NOT authorization: the draft must actually exist for THIS
    //    tenant in the system of record. The same-transaction outbox guarantees
    //    a real draft existed at publish time, so a not-found is PERMANENT
    //    (deleted, or a cross-tenant/forged envelope) — drop with a log, never
    //    loop.
    const draft = await this.talentExtraction.findTalentIntakeDraftById({
      tenant_id: tenantId,
      id: draftId,
    });
    if (draft === null) {
      this.logger.warn({
        event: 'talent_intake_handle_no_authoritative_draft',
        event_id: envelope.event_id,
        tenant_id: tenantId,
        subject_id: draftId,
        correlation_id: envelope.correlation_id,
        outcome: 'skipped',
      });
      return { status: 'skipped', reason: 'draft_not_found' };
    }

    // 3. The EXISTING idempotent CAS processing path, reused via the port (no
    //    duplication). processIntakeDraft does not throw for an extraction
    //    failure (persisted as terminal FAILED/PARTIAL); a throw is transient.
    try {
      const ran = await this.processing.processIntakeDraft({
        draft_id: draftId,
        tenant_id: tenantId,
        correlation_id: envelope.correlation_id,
      });
      this.logger.log({
        event: 'talent_intake_handled',
        event_id: envelope.event_id,
        tenant_id: tenantId,
        subject_id: draftId,
        correlation_id: envelope.correlation_id,
        outcome: ran ? 'processed' : 'noop',
      });
      return ran ? { status: 'processed' } : { status: 'skipped', reason: 'not_claimable' };
    } catch (err) {
      this.logger.warn({
        event: 'talent_intake_handle_failed',
        event_id: envelope.event_id,
        tenant_id: tenantId,
        subject_id: draftId,
        correlation_id: envelope.correlation_id,
        outcome: 'retryable',
        reason: err instanceof Error ? err.message : 'unknown',
      });
      return { status: 'retryable', reason: 'processing_error' };
    }
  }
}
