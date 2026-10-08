import type { AramoLogger } from '@aramo/common';
import type {
  AramoEventEnvelope,
  OutboxPublishResult,
  OutboxPublisherPort,
} from '@aramo/events';

// ADR-0033 / ADR-0018 baseline — the structured-log OutboxPublisherPort
// implementation. A REAL, DI-selectable adapter (local/test/backward-compat),
// NOT an automatic fallback inside the EventBridge adapter: transport selection
// is explicit configuration/DI, never silent degradation on an AWS outage.
//
// Emits one structured line per envelope (metadata only — no payload/PII) and
// reports every envelope as published, since the log IS the delivery for this
// transport.
export class StructuredLogOutboxPublisher implements OutboxPublisherPort {
  constructor(private readonly logger: AramoLogger) {}

  async publish(
    envelopes: readonly AramoEventEnvelope[],
  ): Promise<OutboxPublishResult> {
    for (const env of envelopes) {
      this.logger.log({
        event: 'outbox_event_logged',
        adapter: 'structured-log',
        event_id: env.event_id,
        event_type: env.event_type,
        event_version: env.event_version,
        tenant_id: env.tenant_id,
        source: env.source,
        subject_type: env.subject_type,
        subject_id: env.subject_id,
        correlation_id: env.correlation_id,
        causation_id: env.causation_id,
      });
    }
    return {
      published_event_ids: envelopes.map((e) => e.event_id),
      failed_event_ids: [],
    };
  }
}
