import { Injectable } from '@nestjs/common';
import { RedisConnectionConfig } from '@aramo/common';
import { CanonicalReconcileProducer } from '@aramo/canonical-reconcile';
import { TalentReconcileProducer } from '@aramo/talent-reconcile-signal';
import { TALENT_EVENT_ERASED } from '@aramo/talent-record';

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
    if (event.event_type === TALENT_EVENT_ERASED) return;
    if (!this.redis.isConfigured) return;
    await this.producer.enqueueTalentRequired(event.tenant_id, event.subject_id);
  }
}

// ATI-SEP-1 A3 (b) — the Talent-profile reconcile signal (TI-1F-C §4-H, the
// SEPARATE architecture from the skill canonical reconcile), formerly enqueued
// inline by create / confirm / work-authorization edits. Best-effort +
// Redis-gated inside the producer; the watermark backstop recovers a miss.
@Injectable()
export class TalentReconcileSignalTalentEventHandler implements AtsTalentEventHandler {
  readonly name = 'talent-reconcile-signal';

  constructor(private readonly producer: TalentReconcileProducer) {}

  async handle(event: AtsTalentEventEnvelope): Promise<void> {
    if (event.event_type === TALENT_EVENT_ERASED) return;
    await this.producer.enqueueTalent(event.tenant_id, event.subject_id);
  }
}
