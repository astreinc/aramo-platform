// ADR-0033 — the reusable outbox-dispatch port.
//
// Domain/business code NEVER calls EventBridge/SNS/SQS or any AWS SDK directly
// (ADR-0033 Decision 1). The outbox publisher drains durable rows and hands
// canonical envelopes to whatever adapter is bound to this port. The default
// adapter publishes to the Aramo EventBridge bus; a structured-log adapter (the
// ADR-0018 baseline behaviour) and a test fake satisfy the same contract.

import type { AramoEventEnvelope } from './event-envelope.js';

// Nest DI string token (string, not a bare class — avoids the non-strict
// bare-class-token lookup collision; consumers @Inject(OUTBOX_PUBLISHER_PORT)).
export const OUTBOX_PUBLISHER_PORT = 'OUTBOX_PUBLISHER_PORT';

// Per-event publish outcome. The publisher marks published_at ONLY on
// published_event_ids; failed_event_ids stay unpublished and are retried on the
// next drain tick. This generalises the intake relay's "publish only after the
// transport confirms" discipline: a transport outage leaves the outbox durable
// and retryable, never lost and never prematurely marked.
export interface OutboxPublishResult {
  readonly published_event_ids: readonly string[];
  readonly failed_event_ids: readonly string[];
}

export interface OutboxPublisherPort {
  // At-least-once publish of a batch of envelopes. Implementations MUST return
  // an id in exactly one of the two result arrays for every envelope passed in.
  // Implementations MUST NOT throw for a partial-batch transport failure —
  // partial failure is reported via failed_event_ids so the successful rows
  // still advance. A total/connection failure may throw; the caller then leaves
  // the whole batch unpublished.
  publish(
    envelopes: readonly AramoEventEnvelope[],
  ): Promise<OutboxPublishResult>;
}
