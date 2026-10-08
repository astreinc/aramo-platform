import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import type { AramoLogger } from '@aramo/common';
import type {
  AramoEventEnvelope,
  OutboxPublishResult,
  OutboxPublisherPort,
} from '@aramo/events';
import { EventBridgeOutboxPublisher } from '@aramo/outbox-publisher';

import type { TalentIntakeEventsConfig } from './talent-intake-events.config.js';

// ADR-0033 — lazy, FAIL-CLOSED EventBridge OutboxPublisherPort. When
// transport=eventbridge the composition binds THIS (never structured-log), so a
// misconfigured production can never silently degrade. The real SDK client +
// adapter are built on the FIRST publish (mirroring the lazy S3ClientFactory) so
// module bootstrap never throws (keeping full-AppModule tests healthy). A missing
// bus throws LOUDLY on that first publish — fail-closed, with NO structured-log
// or BullMQ fallback — and the drain's lease model leaves the unpublished rows
// retryable.
export class LazyEventBridgeOutboxPublisher implements OutboxPublisherPort {
  private delegate: EventBridgeOutboxPublisher | null = null;

  constructor(
    private readonly config: TalentIntakeEventsConfig,
    private readonly logger: AramoLogger,
  ) {}

  private resolve(): EventBridgeOutboxPublisher {
    if (this.delegate !== null) return this.delegate;
    if (this.config.busName === null) {
      throw new Error(
        'TALENT_INTAKE_EVENT_BUS is required for the EventBridge intake transport ' +
          '(fail-closed; no structured-log/BullMQ fallback).',
      );
    }
    const client = new EventBridgeClient({
      ...(this.config.region !== null ? { region: this.config.region } : {}),
      ...(this.config.endpoint !== null ? { endpoint: this.config.endpoint } : {}),
    });
    this.delegate = new EventBridgeOutboxPublisher(
      client,
      { busName: this.config.busName, sourcePrefix: this.config.sourcePrefix },
      this.logger,
    );
    return this.delegate;
  }

  async publish(
    envelopes: readonly AramoEventEnvelope[],
  ): Promise<OutboxPublishResult> {
    return this.resolve().publish(envelopes);
  }
}
