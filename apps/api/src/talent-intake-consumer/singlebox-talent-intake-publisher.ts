import type { AramoLogger } from '@aramo/common';
import type {
  AramoEventEnvelope,
  OutboxPublishResult,
  OutboxPublisherPort,
} from '@aramo/events';
import type { TalentIntakeMessageHandler } from '@aramo/talent-record';

// ADR-0033 / single-box — the OUTBOX_PUBLISHER_PORT adapter for
// TALENT_INTAKE_TRANSPORT=singlebox. Instead of publishing to EventBridge, it
// delivers each canonical outbox envelope DIRECTLY to the in-process
// TalentIntakeMessageHandler (the SAME handler the SQS→Lambda consumer uses), so
// there is NO duplicated extraction logic and NO AWS dependency on the single-box
// topology. It contains transport/delivery mapping ONLY — no extraction/business
// logic.
//
// Delivery semantics, mapped onto the lease-safe drain's publish contract:
//   handler 'processed' | 'skipped' | 'malformed'  → published_event_ids
//     (the event was SUCCESSFULLY HANDLED per the handler contract — including a
//      terminal FAILED/PARTIAL extraction BUSINESS result, which is NOT a
//      transport failure, and 'malformed'/'skipped' which must never loop).
//   handler 'retryable', or an UNEXPECTED throw      → failed_event_ids
//     (left unpublished; the drain's lease/retry/quarantine machinery retries).
// Per the OutboxPublisherPort contract this NEVER throws for a per-envelope
// failure; every envelope id is reported in exactly one result array. Lease-safe
// FOR UPDATE SKIP LOCKED claiming, multi-process safety, bounded retries,
// quarantine/exhaustion, and idempotent CAS processing are ALL owned by the
// existing drain + handler — this adapter adds none of them.
export class SingleBoxTalentIntakePublisher implements OutboxPublisherPort {
  constructor(
    private readonly handler: TalentIntakeMessageHandler,
    private readonly logger: AramoLogger,
  ) {}

  async publish(
    envelopes: readonly AramoEventEnvelope[],
  ): Promise<OutboxPublishResult> {
    const published: string[] = [];
    const failed: string[] = [];
    for (const envelope of envelopes) {
      try {
        const outcome = await this.handler.handle(envelope);
        if (outcome.status === 'retryable') {
          failed.push(envelope.event_id);
          this.logger.warn({
            event: 'talent_intake_singlebox_deliver_retryable',
            event_id: envelope.event_id,
            correlation_id: envelope.correlation_id,
            reason: outcome.reason,
          });
        } else {
          // processed | skipped | malformed → acknowledged (mark published).
          published.push(envelope.event_id);
        }
      } catch (err) {
        // An UNEXPECTED throw out of the handler is treated as transient — keep
        // the event retryable via the drain's lease machinery; never lose it.
        failed.push(envelope.event_id);
        this.logger.warn({
          event: 'talent_intake_singlebox_deliver_threw',
          event_id: envelope.event_id,
          correlation_id: envelope.correlation_id,
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }
    return { published_event_ids: published, failed_event_ids: failed };
  }
}
