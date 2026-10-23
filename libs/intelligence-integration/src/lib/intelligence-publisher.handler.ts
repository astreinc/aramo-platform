import { Injectable, Logger } from '@nestjs/common';
import { EntitlementRepository } from '@aramo/entitlement';
import type { AramoEventEnvelope } from '@aramo/events';
import { SOURCE_SYSTEM_ARAMO_ATS } from '@aramo/intelligence-contracts';
import { TalentEvidenceRepository } from '@aramo/talent-evidence';
import {
  TALENT_EVENT_CREATED,
  TALENT_EVENT_DELETED,
  TALENT_EVENT_ERASED,
  TALENT_EVENT_PROFILE_UPDATED,
  TalentIntelligenceRepository,
  type TalentEventPayload,
} from '@aramo/talent-record';

import { buildTalentIngestRequest } from './ingest-payload-builder.js';
import { IntelligenceClient, IntelligenceRejectedError } from './intelligence-client.js';
import { IntelligenceEntitlementSyncService } from './intelligence-entitlement-sync.service.js';
import { fieldKeysOfColumns } from './sync-policy.js';

// ATI-SEP-1 T8 (ADR-0036 §3 "ATS → TI") — the Intelligence PUBLISHER, an
// ATS_TALENT_EVENT_HANDLERS member run by the talent-intake-worker's lease-safe
// outbox drain (POST-COMMIT, never on an ATS request path; the ATS write
// committed before the row was claimable).
//
//   talent.created / talent.profile_updated
//       not configured        → no-op success, outcome TI_NOT_CONFIGURED
//       tenant lacks the `intelligence` capability → no-op, outcome NOT_ENTITLED
//       record gone           → no-op, outcome TALENT_NOT_FOUND
//       else read the committed record + typed evidence, build the allowlisted
//       admission payload, validate it (fail closed), POST /v1/ingest/talent
//       (source_event_id = the outbox event id → TI-side idempotency), link the
//       returned Golden subject (intelligence_link).
//   talent.erased   → POST /v1/ingest/talent/erased (reference → ERASED, A1).
//   talent.deleted  → treated as erased FOR TI: the recruiter's hard delete
//       removes the ATS record, so TI must stop treating the reference as an
//       ACTIVE link (subject access state follows A1). The ATS-side semantics of
//       delete ≠ erase are unchanged.
//
// TI unavailable (network / timeout / 5xx / 429) → THROW: the dispatcher reports
// the event failed and the drain retries it with backoff (then quarantines it).
// A TI refusal of an erased reference (409 REFERENCE_ERASED) is final → no-op.
// Any other refusal (400 admission, 403) is thrown as well: it is a defect to see
// in the quarantine, never silently dropped. Idempotent: TI dedupes on
// source_event_id; the link upsert is keyed (tenant, talent).

export type PublisherOutcome =
  | 'TI_NOT_CONFIGURED'
  | 'NOT_ENTITLED'
  | 'TALENT_NOT_FOUND'
  | 'INGESTED'
  | 'ERASED'
  | 'REFERENCE_ERASED'
  | 'IGNORED';

const INTELLIGENCE_CAPABILITY = 'intelligence' as const;

@Injectable()
export class IntelligencePublisherHandler {
  readonly name = 'intelligence-publisher';
  private readonly logger = new Logger('IntelligencePublisher');

  constructor(
    private readonly client: IntelligenceClient,
    private readonly entitlements: EntitlementRepository,
    private readonly entitlementSync: IntelligenceEntitlementSyncService,
    private readonly records: TalentIntelligenceRepository,
    private readonly evidence: TalentEvidenceRepository,
  ) {}

  async handle(event: AramoEventEnvelope<TalentEventPayload>): Promise<void> {
    const outcome = await this.publish(event);
    // ids + names only — never a payload value.
    this.logger.log({
      event: 'intelligence_publish',
      outcome,
      event_id: event.event_id,
      event_type: event.event_type,
      tenant_id: event.tenant_id,
      subject_id: event.subject_id,
    });
  }

  async publish(event: AramoEventEnvelope<TalentEventPayload>): Promise<PublisherOutcome> {
    const known = [TALENT_EVENT_CREATED, TALENT_EVENT_PROFILE_UPDATED, TALENT_EVENT_ERASED, TALENT_EVENT_DELETED];
    if (!known.includes(event.event_type)) return 'IGNORED';
    if (!this.client.configured) return 'TI_NOT_CONFIGURED';
    const capabilities = await this.entitlements.getCapabilities(event.tenant_id);
    if (!capabilities.has(INTELLIGENCE_CAPABILITY)) return 'NOT_ENTITLED';
    const talentId = event.payload?.talent_record_id ?? event.subject_id;

    if (event.event_type === TALENT_EVENT_ERASED || event.event_type === TALENT_EVENT_DELETED) {
      await this.client.ingestErased({
        source_system_id: SOURCE_SYSTEM_ARAMO_ATS,
        source_tenant_id: event.tenant_id,
        external_talent_id: talentId,
        source_event_id: event.event_id,
        occurred_at: event.occurred_at,
      });
      return 'ERASED';
    }

    const record = await this.records.readAdmissibleRecord({ tenant_id: event.tenant_id, id: talentId });
    if (record === null) return 'TALENT_NOT_FOUND';
    const [evidence, tiSourced] = await Promise.all([
      this.evidence.readEvidenceForIntelligence({ tenant_id: event.tenant_id, talent_id: talentId }),
      this.records.listIntelligenceSourcedFields(talentId),
    ]);
    // Throws IngestPayloadRejectedError (fail closed) — the event is retried, then quarantined.
    const { request, dropped } = buildTalentIngestRequest({
      source_event_id: event.event_id,
      occurred_at: event.occurred_at,
      record,
      evidence,
      intelligence_sourced_fields: fieldKeysOfColumns(tiSourced),
    });
    if (dropped.length > 0) {
      this.logger.warn({
        event: 'intelligence_publish_items_dropped',
        event_id: event.event_id,
        tenant_id: event.tenant_id,
        dropped: dropped.length,
        paths: dropped.slice(0, 20).map((d) => `${d.path}:${d.code}`),
      });
    }

    await this.entitlementSync.ensureEntitled(event.tenant_id);
    try {
      const response = await this.client.ingestTalent(request);
      await this.records.upsertLink({
        tenant_id: event.tenant_id,
        talent_record_id: talentId,
        intelligence_subject_id: response.intelligence_subject_id,
      });
      return 'INGESTED';
    } catch (err) {
      if (err instanceof IntelligenceRejectedError && err.status === 409 && err.code === 'REFERENCE_ERASED') return 'REFERENCE_ERASED';
      throw err;
    }
  }
}
