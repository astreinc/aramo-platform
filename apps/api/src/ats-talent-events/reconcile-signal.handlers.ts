import { Injectable } from '@nestjs/common';
import { RedisConnectionConfig } from '@aramo/common';
import { CanonicalReconcileProducer } from '@aramo/canonical-reconcile';
import { TALENT_EVENT_DELETED, TALENT_EVENT_ERASED } from '@aramo/talent-record';

import type { AtsTalentEventEnvelope, AtsTalentEventHandler } from './ats-talent-event-handler.js';

// ATI-SEP-1 A3 (a) — the SKILL canonical reconcile, formerly enqueued inline by
// the create / confirm paths. Fired for talent.created and
// talent.profile_updated. Without Redis it is the same silent no-op it always
// was (the backstop recovers); with Redis the REQUIRED enqueue is used so a
// queue failure fails the dispatch and is retried (idempotent jobId).
@Injectable()
export class CanonicalReconcileTalentEventHandler implements AtsTalentEventHandler {
  readonly name = 'canonical-reconcile';

  constructor(
    private readonly producer: CanonicalReconcileProducer,
    private readonly redis: RedisConnectionConfig,
  ) {}

  async handle(event: AtsTalentEventEnvelope): Promise<void> {
    // The Talent no longer exists (erased or deleted) — nothing to reconcile.
    if (event.event_type === TALENT_EVENT_ERASED || event.event_type === TALENT_EVENT_DELETED) return;
    if (!this.redis.isConfigured) return;
    await this.producer.enqueueTalentRequired(event.tenant_id, event.subject_id);
  }
}
