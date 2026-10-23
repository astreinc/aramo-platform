import { Injectable } from '@nestjs/common';
import { TALENT_EVENT_CREATED, TALENT_EVENT_PROFILE_UPDATED } from '@aramo/talent-record';

import { DuplicateDetectionService } from '../talent-identity/duplicate-detection.service.js';

import type { AtsTalentEventEnvelope, AtsTalentEventHandler } from './ats-talent-event-handler.js';

// ATI-SEP-1 T10 WP2 (Addenda A2 F-1 / A3) — the ATS-local within-tenant duplicate
// detector, fired post-commit for talent.created and talent.profile_updated. It
// raises PENDING_REVIEW advisories for same-tenant live records (and un-linked
// sourced arrivals) sharing the record's normalized primary email or cell phone.
// Idempotent on the advisory unique keys (at-least-once delivery is harmless);
// a record that no longer exists / is not live raises nothing. Replaces the
// retired hourly trust match sweep + the daily identity-detection cron.
@Injectable()
export class DuplicateDetectionTalentEventHandler implements AtsTalentEventHandler {
  readonly name = 'duplicate-detection';

  constructor(private readonly detection: DuplicateDetectionService) {}

  async handle(event: AtsTalentEventEnvelope): Promise<void> {
    if (event.event_type !== TALENT_EVENT_CREATED && event.event_type !== TALENT_EVENT_PROFILE_UPDATED) {
      return;
    }
    await this.detection.detectForRecord(event.tenant_id, event.subject_id);
  }
}
