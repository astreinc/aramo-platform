import {
  EventBridgeClient,
  PutEventsCommand,
  type PutEventsRequestEntry,
} from '@aws-sdk/client-eventbridge';
import type { AramoLogger } from '@aramo/common';
import type {
  AramoEventEnvelope,
  OutboxPublishResult,
  OutboxPublisherPort,
} from '@aramo/events';

// ADR-0033 — the EventBridge adapter for OutboxPublisherPort. INFRASTRUCTURE
// ONLY: PutEventsCommand, the bus name, AWS error shapes, and SDK retry metadata
// never escape this file into @aramo/events or the Talent domain. The domain /
// drain depend solely on the port contract.
//
// PutEvents accepts at most 10 entries per request and reports PER-ENTRY success
// or failure (response Entries[] is positional: entries[i] ↔ the i-th request
// entry). This adapter maps that per-entry result back to the envelope's
// event_id so the drain marks ONLY transport-confirmed ids published. A whole
// chunk is treated as failed only when the request itself throws (connection/
// auth/total outage) — never because a 200 response contained some failures.

export interface EventBridgeOutboxPublisherConfig {
  readonly busName: string;
  // EventBridge "source" prefix, e.g. 'aramo' → source becomes 'aramo.<source>'.
  readonly sourcePrefix: string;
}

const MAX_ENTRIES_PER_PUT = 10;

export class EventBridgeOutboxPublisher implements OutboxPublisherPort {
  constructor(
    private readonly client: EventBridgeClient,
    private readonly config: EventBridgeOutboxPublisherConfig,
    private readonly logger: AramoLogger,
  ) {}

  async publish(
    envelopes: readonly AramoEventEnvelope[],
  ): Promise<OutboxPublishResult> {
    const published: string[] = [];
    const failed: string[] = [];

    for (let i = 0; i < envelopes.length; i += MAX_ENTRIES_PER_PUT) {
      const chunk = envelopes.slice(i, i + MAX_ENTRIES_PER_PUT);
      const entries: PutEventsRequestEntry[] = chunk.map((env) => ({
        EventBusName: this.config.busName,
        Source: `${this.config.sourcePrefix}.${env.source}`,
        DetailType: env.event_type,
        Detail: JSON.stringify(env),
        Time: new Date(env.occurred_at),
        Resources: [`${env.subject_type}:${env.subject_id}`],
      }));

      try {
        const res = await this.client.send(
          new PutEventsCommand({ Entries: entries }),
        );
        const resultEntries = res.Entries ?? [];
        chunk.forEach((env, idx) => {
          // Positional: the i-th result corresponds to the i-th request entry.
          const entry = resultEntries[idx];
          if (entry !== undefined && entry.ErrorCode === undefined && entry.EventId !== undefined) {
            published.push(env.event_id);
          } else {
            failed.push(env.event_id);
            this.logger.warn({
              event: 'eventbridge_put_entry_failed',
              event_id: env.event_id,
              tenant_id: env.tenant_id,
              event_type: env.event_type,
              correlation_id: env.correlation_id,
              failure_category: 'transport',
              // AWS error code stays here (infra), not surfaced to the domain.
              aws_error_code: entry?.ErrorCode ?? 'no_result_entry',
            });
          }
        });
      } catch (err) {
        // Request-level failure (connection/auth/total outage): the whole chunk
        // is unconfirmed → failed. Never partially published on a throw.
        for (const env of chunk) {
          failed.push(env.event_id);
        }
        this.logger.warn({
          event: 'eventbridge_put_request_failed',
          failure_category: 'transport',
          chunk_size: chunk.length,
          reason: err instanceof Error ? err.message : 'unknown',
        });
      }
    }

    return { published_event_ids: published, failed_event_ids: failed };
  }
}
