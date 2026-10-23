import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  CONSENT_SOURCE_TYPES,
  SourceConsentService,
  type ConsentSourceType,
} from '@aramo/consent';
import { IngestionRepository } from '@aramo/ingestion';
import { SourcedTalentRepository } from '@aramo/sourced-talent';
import {
  normalizePhoneForDedupe,
  talentDuplicateError,
  TalentDuplicateAdvisoryRepository,
  TalentRecordRepository,
  type CreateTalentRecordRequestDto,
  type DuplicateSharedKind,
} from '@aramo/talent-record';

import { DuplicateDetectionService } from './duplicate-detection.service.js';
import {
  PROMOTION_SOURCED_STATUS,
  PROMOTION_SYSTEM_ACTOR_ID,
} from './promotion.constants.js';
import { describeSourcedArrival } from './sourced-arrival.view.js';

// ATI-SEP-1 T10 WP2 — sourcing promotion (sourced arrival → TalentRecord), rebuilt
// on ATS data only (Addenda A2 F-1 / A3: ATS keeps sourcing + every recruiter
// decision; Talent Intelligence output never gates it). apps/api orchestration:
// reads sourced_talent + the ingestion arrival, writes talent_record + consent.
//
//   1. unknown arrival (or another tenant's)       → deferred_unknown_subject
//   2. arrival already linked to a record           → already_promoted (no-op)
//   3. a PENDING_REVIEW duplicate advisory names it  → deferred_unresolved_identity
//   4. no two-part name on the arrival               → deferred_no_name
//   5. no mappable legal-basis arrival               → deferred_no_basis
//   6. missing email1 or cell phone (A2 admission)   → deferred_incomplete_contact
//   7. a live record in the tenant shares the email
//      or normalized cell phone                      → a SOURCED_ARRIVAL advisory is
//      raised for review and the call fails 409 TALENT_RECORD_DUPLICATE (the same
//      refusal Add Talent returns)
//   8. otherwise mint the record through the talent-record create path (in-txn
//      dedupe re-check + the PROMOTED arrival link + the talent.created outbox row,
//      one transaction), then reconcile the arrival's legal basis to an L3
//      TalentConsentEvent.

export interface SourcedArrivalRef {
  tenant_id: string;
  sourced_talent_id: string;
}

export type PromotionOutcome =
  | { status: 'promoted'; talent_record_id: string }
  | { status: 'already_promoted'; talent_record_id: string }
  | { status: 'deferred_no_name' }
  | { status: 'deferred_no_basis' }
  | { status: 'deferred_unknown_subject' }
  | { status: 'deferred_unresolved_identity' }
  | { status: 'deferred_incomplete_contact' };

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    private readonly sourced: SourcedTalentRepository,
    private readonly advisories: TalentDuplicateAdvisoryRepository,
    private readonly detection: DuplicateDetectionService,
    private readonly talentRecords: TalentRecordRepository,
    private readonly sourceConsent: SourceConsentService,
    private readonly ingestion: IngestionRepository,
  ) {}

  async promoteArrival(
    ref: SourcedArrivalRef,
    opts?: { requestId?: string; actor_id?: string | null },
  ): Promise<PromotionOutcome> {
    const tenant_id = ref.tenant_id;
    const requestId = opts?.requestId ?? `promote:sourced:${ref.sourced_talent_id}`;

    // 1. The arrival, tenant-walled (another tenant's id reads as unknown).
    const arrival = await this.sourced.findById(ref.sourced_talent_id);
    if (arrival === null || arrival.tenant_id !== tenant_id) {
      return { status: 'deferred_unknown_subject' };
    }

    // 2. Idempotent no-op — an arrival already linked to a record returns it.
    const link = await this.advisories.findArrivalLink(tenant_id, arrival.id);
    if (link !== null) {
      return { status: 'already_promoted', talent_record_id: link.talent_record_id };
    }

    // 3. The identity gate — an unresolved ATS duplicate advisory for this arrival.
    const pending = await this.advisories.listForArrival(tenant_id, arrival.id, 'PENDING_REVIEW');
    if (pending.length > 0) {
      this.logger.warn(
        `promoteArrival: arrival ${arrival.id} has ${pending.length} pending duplicate advisory(ies); deferring (${requestId})`,
      );
      return { status: 'deferred_unresolved_identity' };
    }

    // 4. Name — both parts (the TalentRecord contract is non-null first + last).
    const d = describeSourcedArrival(arrival);
    if (d.first_name === null || d.last_name === null) return { status: 'deferred_no_name' };

    // 5. Legal basis — the ingestion arrival this row was landed from.
    if (d.ingestion_payload_id === null) return { status: 'deferred_no_basis' };
    const payload = await this.ingestion.findById({ id: d.ingestion_payload_id });
    if (payload === null || payload.tenant_id !== tenant_id) return { status: 'deferred_no_basis' };
    if (!isConsentSource(payload.source)) {
      this.logger.warn(
        `promoteArrival: arrival source "${payload.source}" is not a consent source type; deferring (${requestId})`,
      );
      return { status: 'deferred_no_basis' };
    }

    // 6. Admission anchors (A2) — primary email AND cell phone.
    const email1 = (d.email ?? '').trim();
    const phoneCell = (d.phone ?? '').trim();
    if (email1 === '' || phoneCell === '') return { status: 'deferred_incomplete_contact' };

    // 7. Tenant-local duplicate pre-check (the create re-checks under locks).
    const dup = await this.talentRecords.findActiveDuplicate({
      tenant_id,
      email1,
      phone_cell: phoneCell,
    });
    if (dup !== null) {
      await this.flagDuplicate(tenant_id, arrival.id, dup.id, email1, phoneCell);
      // The same 409 the Add Talent path returns.
      throw talentDuplicateError(dup, requestId);
    }

    const input: CreateTalentRecordRequestDto = {
      first_name: d.first_name,
      last_name: d.last_name,
      email1,
      phone_cell: phoneCell,
      ...(d.headline !== null ? { current_employer: d.headline } : {}),
      ...(d.profile_url !== null ? { web_site: d.profile_url } : {}),
      source: payload.source,
    };

    // 8. Mint (system actor) — record + PROMOTED link + talent.created, one txn.
    let recordId: string;
    try {
      const record = await this.talentRecords.create({
        tenant_id,
        entered_by_id: PROMOTION_SYSTEM_ACTOR_ID,
        input,
        requestId,
        tenant_status: PROMOTION_SOURCED_STATUS,
        dedupe: true,
        sourced_arrival: { sourced_talent_id: arrival.id, linked_by: opts?.actor_id ?? null },
        event: { correlation_id: requestId },
      });
      recordId = record.id;
    } catch (err) {
      // A concurrent promotion of the same arrival won the link PK → its record.
      const raced = await this.advisories.findArrivalLink(tenant_id, arrival.id);
      if (raced !== null) {
        return { status: 'already_promoted', talent_record_id: raced.talent_record_id };
      }
      // The in-txn duplicate re-check fired (a concurrent create of the human).
      const existingId = duplicateExistingId(err);
      if (existingId !== null) {
        await this.flagDuplicate(tenant_id, arrival.id, existingId, email1, phoneCell);
      }
      throw err;
    }

    // 9. Reconcile the arrival's legal basis → L3 TalentConsentEvent, carrying
    //    the arrival's source channel + server-derived source_class verbatim.
    await this.sourceConsent.registerSourceDerivedConsent({
      tenant_id,
      talent_record_id: recordId,
      source: payload.source,
      source_class: payload.source_class,
      occurred_at: payload.captured_at.toISOString(),
      requestId,
    });

    this.logger.log(
      `promoteArrival: promoted arrival ${arrival.id} → TalentRecord ${recordId} (source=${payload.source}, ${requestId})`,
    );
    return { status: 'promoted', talent_record_id: recordId };
  }

  private async flagDuplicate(
    tenant_id: string,
    sourced_talent_id: string,
    talent_record_id: string,
    email1: string,
    phoneCell: string,
  ): Promise<void> {
    const keys = await this.advisories.findRecordContactKeys(tenant_id, talent_record_id);
    const kinds: DuplicateSharedKind[] = [];
    if (keys?.email !== null && keys?.email === email1.toLowerCase()) kinds.push('EMAIL');
    if (keys?.phone !== null && keys?.phone === normalizePhoneForDedupe(phoneCell)) kinds.push('PHONE');
    await this.detection.flagArrivalAgainstRecord({
      tenant_id,
      sourced_talent_id,
      talent_record_id,
      kinds: kinds.length > 0 ? kinds : ['EMAIL'],
    });
  }
}

function isConsentSource(source: string): source is ConsentSourceType {
  return (CONSENT_SOURCE_TYPES as readonly string[]).includes(source);
}

function duplicateExistingId(err: unknown): string | null {
  if (!(err instanceof AramoError) || err.code !== 'TALENT_RECORD_DUPLICATE') return null;
  const existing = (err.context.details as { existing_id?: unknown } | undefined)?.existing_id;
  return typeof existing === 'string' ? existing : null;
}
