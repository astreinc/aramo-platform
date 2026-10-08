import type { AramoLogger } from '@aramo/common';
import type { AramoEventEnvelope } from '@aramo/events';
import type {
  TalentIntakeHandleOutcome,
  TalentIntakeMessageHandler,
} from '@aramo/talent-record';

import type {
  SqsBatchResponse,
  SqsRecordLike,
} from './sqs-event.types.js';

// ADR-0033 — the thin SQS→Lambda adapter boundary. Owns SQS record decode,
// EventBridge-envelope UNWRAP, canonical-envelope validation, infra logging, and
// the partial-batch-response mapping. Passes ONLY a validated AramoEventEnvelope
// inward to the runtime-neutral handler. No AWS types reach the handler.
//
// Outcome → transport mapping:
//   processed / skipped → ack (omit from batchItemFailures)
//   retryable           → batchItemFailures += messageId (SQS redelivers; after
//                         maxReceiveCount it redrives to the consumer DLQ)
//   malformed           → explicit drop WITH a log (never looped); omitted from
//                         failures so a permanently-invalid message is removed,
//                         not retried forever.

// EventBridge delivers to SQS with the domain event wrapped in its own envelope:
// { version, id, detail-type, source, detail: <AramoEventEnvelope>, ... }. Unwrap
// to the canonical envelope. Also accept a direct AramoEventEnvelope body (tests
// / non-EventBridge producers).
function unwrapToEnvelope(body: string): unknown {
  const parsed: unknown = JSON.parse(body);
  if (parsed !== null && typeof parsed === 'object' && 'detail' in parsed) {
    const detail = (parsed as { detail: unknown }).detail;
    if (detail !== null && detail !== undefined) {
      return detail;
    }
  }
  return parsed;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// Structural validation of the canonical envelope. Returns the typed envelope or
// null (malformed). The handler then does SEMANTIC validation + authoritative
// re-check.
export function validateEnvelope(raw: unknown): AramoEventEnvelope | null {
  if (raw === null || typeof raw !== 'object') {
    return null;
  }
  const c = raw as Record<string, unknown>;
  if (
    !isNonEmptyString(c.event_id) ||
    !isNonEmptyString(c.event_type) ||
    !isNonEmptyString(c.event_version) ||
    !isNonEmptyString(c.tenant_id) ||
    !isNonEmptyString(c.source) ||
    !isNonEmptyString(c.subject_type) ||
    !isNonEmptyString(c.subject_id) ||
    !isNonEmptyString(c.occurred_at) ||
    !isNonEmptyString(c.correlation_id) ||
    !('payload' in c)
  ) {
    return null;
  }
  const causation = c.causation_id;
  if (causation !== null && typeof causation !== 'string') {
    return null;
  }
  return {
    event_id: c.event_id,
    event_type: c.event_type,
    event_version: c.event_version,
    tenant_id: c.tenant_id,
    source: c.source,
    subject_type: c.subject_type,
    subject_id: c.subject_id,
    occurred_at: c.occurred_at,
    correlation_id: c.correlation_id,
    causation_id: (causation as string | null) ?? null,
    payload: c.payload,
  };
}

// Process one SQS batch. Pure w.r.t. AWS SDK (takes plain records + the handler),
// so partial success / outage / malformed are all testable without Lambda.
export async function processTalentIntakeSqsBatch(
  records: readonly SqsRecordLike[],
  handler: Pick<TalentIntakeMessageHandler, 'handle'>,
  logger: AramoLogger,
): Promise<SqsBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of records) {
    const receiveCount = record.attributes?.ApproximateReceiveCount ?? 'unknown';

    let raw: unknown;
    try {
      raw = unwrapToEnvelope(record.body);
    } catch {
      logger.warn({
        event: 'talent_intake_sqs_body_unparseable',
        message_id: record.messageId,
        receive_count: receiveCount,
        outcome: 'malformed_dropped',
      });
      continue; // permanently invalid → drop with log, do not retry
    }

    const envelope = validateEnvelope(raw);
    if (envelope === null) {
      logger.warn({
        event: 'talent_intake_sqs_envelope_invalid',
        message_id: record.messageId,
        receive_count: receiveCount,
        outcome: 'malformed_dropped',
      });
      continue;
    }

    const outcome: TalentIntakeHandleOutcome = await handler.handle(envelope);

    logger.log({
      event: 'talent_intake_sqs_record_outcome',
      message_id: record.messageId,
      receive_count: receiveCount,
      event_id: envelope.event_id,
      correlation_id: envelope.correlation_id,
      outcome: outcome.status,
      reason: 'reason' in outcome ? outcome.reason : undefined,
    });

    switch (outcome.status) {
      case 'processed':
      case 'skipped':
        break; // ack — successful record is NOT replayed
      case 'retryable':
        batchItemFailures.push({ itemIdentifier: record.messageId });
        break;
      case 'malformed':
        // Explicit malformed policy: drop with the log above, never loop.
        break;
    }
  }

  return { batchItemFailures };
}
