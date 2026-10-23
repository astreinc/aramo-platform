import { Inject, Injectable } from '@nestjs/common';
import type { AramoLogger } from '@aramo/common';
import type {
  AramoEventEnvelope,
  OutboxPublishResult,
  OutboxPublisherPort,
} from '@aramo/events';
import {
  TALENT_EVENT_CREATED,
  TALENT_EVENT_ERASED,
  TALENT_EVENT_PROFILE_UPDATED,
} from '@aramo/talent-record';

import {
  ATS_TALENT_EVENT_HANDLERS,
  type AtsTalentEventEnvelope,
  type AtsTalentEventHandler,
} from './ats-talent-event-handler.js';

const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  TALENT_EVENT_CREATED,
  TALENT_EVENT_PROFILE_UPDATED,
  TALENT_EVENT_ERASED,
]);

// ATI-SEP-1 A3 — the in-process OutboxPublisherPort for the ATS talent outbox.
// The lease-safe drain hands it canonical envelopes; it fans each one out to
// every registered handler IN ORDER. An event is reported published only when
// ALL handlers succeeded; any failure reports it failed, so the drain keeps the
// row leased for the retry backoff (and quarantines it past the attempt budget).
// Handlers are isolated from each other (one failing does not skip the rest)
// and from the ATS write (which committed before the row was ever claimable).
// An unknown event type is acknowledged as a no-op (forward compatibility), never
// retried.
@Injectable()
export class AtsTalentEventDispatcher implements OutboxPublisherPort {
  constructor(
    @Inject(ATS_TALENT_EVENT_HANDLERS)
    private readonly handlers: readonly AtsTalentEventHandler[],
    @Inject('AtsTalentEventDispatcherLogger')
    private readonly logger: AramoLogger,
  ) {}

  async publish(envelopes: readonly AramoEventEnvelope[]): Promise<OutboxPublishResult> {
    const published: string[] = [];
    const failed: string[] = [];
    for (const envelope of envelopes) {
      if (!KNOWN_EVENTS.has(envelope.event_type)) {
        published.push(envelope.event_id);
        continue;
      }
      let ok = true;
      for (const handler of this.handlers) {
        try {
          await handler.handle(envelope as AtsTalentEventEnvelope);
        } catch (err) {
          ok = false;
          // ids + names only — never payload values.
          this.logger.warn({
            event: 'ats_talent_event_handler_failed',
            handler: handler.name,
            event_id: envelope.event_id,
            event_type: envelope.event_type,
            tenant_id: envelope.tenant_id,
            subject_id: envelope.subject_id,
            reason: err instanceof Error ? err.message : 'unknown',
          });
        }
      }
      (ok ? published : failed).push(envelope.event_id);
    }
    return { published_event_ids: published, failed_event_ids: failed };
  }
}
