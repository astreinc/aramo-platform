import { Injectable } from '@nestjs/common';
import { SubjectMatcherService } from '@aramo/talent-trust';
import { TALENT_EVENT_ERASED, TalentRecordRepository } from '@aramo/talent-record';

import { LegacyTrustProjectionService } from '../legacy-trust-projection/legacy-trust-projection.service.js';
import { TalentAnchorProducerService } from '../talent-anchor/talent-anchor-producer.service.js';

import type { AtsTalentEventEnvelope, AtsTalentEventHandler } from './ats-talent-event-handler.js';

// TEMPORARY — ATI-SEP-1 §5; deleted at T10 together with the legacy trust
// substrate, when the Talent Intelligence publisher (T8) is the only consumer.
//
// ATI-SEP-1 A3 (c) — the LEGACY trust feed, moved OFF the ATS request path. It
// replaces (1) the global APP_INTERCEPTOR that recorded EMAIL/PHONE anchors and
// ran the same-human matcher on POST/PATCH /v1/talent-records, and (2) the
// declared-evidence ledger routing the create path used to do inline. Running
// post-commit off talent.created / talent.profile_updated, it keeps the live
// legacy trust features fed while the ATS write never waits on (or fails with)
// them. Every step is idempotent (recordAnchor, the advise-only matcher, and the
// source_ref-keyed recordDeclaredClaimIfAbsent), so an at-least-once retry is
// harmless. An erased / absent Talent is a no-op.
@Injectable()
export class LegacyTrustTalentEventHandler implements AtsTalentEventHandler {
  readonly name = 'legacy-trust-projection';

  constructor(
    private readonly talentRecords: TalentRecordRepository,
    private readonly anchors: TalentAnchorProducerService,
    private readonly matcher: SubjectMatcherService,
    private readonly projection: LegacyTrustProjectionService,
  ) {}

  async handle(event: AtsTalentEventEnvelope): Promise<void> {
    if (event.event_type === TALENT_EVENT_ERASED) return;
    const view = await this.talentRecords.findById({
      tenant_id: event.tenant_id,
      id: event.subject_id,
    });
    if (view === null) return;
    // TR-2a-1 — the record's identifier anchors (idempotent).
    await this.anchors.recordAnchorsForView(view);
    // TR-2a-3 (R7) — surface fresh same-human advisories; advise-only.
    await this.matcher.matchForRef(view.tenant_id, 'ATS_TALENT_RECORD', view.id);
    // TR-4 B2 / TR-7 B1 / TI-1C — typed ATS evidence → declared ledger claims.
    await this.projection.routeDeclaredEvidenceToLedger({
      tenant_id: view.tenant_id,
      talent_id: view.id,
    });
    // HF2 R1/R7 — the persisted experience assertions → EXPERIENCE_CLAIM rows.
    await this.projection.routePersistedExperienceAssertionsToLedger({
      tenant_id: view.tenant_id,
      talent_id: view.id,
    });
  }
}
