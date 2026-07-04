import { Injectable, Logger } from '@nestjs/common';
import {
  CONSENT_SOURCE_TYPES,
  SourceConsentService,
  type ConsentSourceType,
} from '@aramo/consent';
import { IngestionRepository } from '@aramo/ingestion';
import {
  TalentRecordRepository,
  type CreateTalentRecordRequestDto,
} from '@aramo/talent-record';
import {
  TalentTrustService,
  type EvidenceRecordRow,
  type SubjectRef,
  type TrustStateRow,
} from '@aramo/talent-trust';

import {
  PROMOTION_LINK_SOURCE,
  PROMOTION_SYSTEM_ACTOR_ID,
} from './promotion.constants.js';

// Promotion Gate — Slice A (create branch). apps/api orchestration ABOVE the
// I15 wall: reads the cip trust ledger (talent_trust) + the cip ingestion
// arrival, and writes the ats heart (talent_record) + the consent ledger.
// talent_trust/ingestion import NO ats; this composition-root service is the
// only place the L2→L3 bridge is crossed (the TalentAnchorProducerService
// precedent).
//
// create-or-reconcile, CREATE branch only (Lifecycle Spec §3 stage 3):
//   - subject already linked to a TalentRecord (ATS_TALENT_RECORD ref) → no-op,
//     return the existing record (idempotent). Enrich-on-re-arrival is slice B.
//   - subject with declared identity evidence + no record → mint a named
//     TalentRecord from the evidence (system actor), attach the ATS_TALENT_RECORD
//     ref, reconcile the arrival's legal basis to an L3 TalentConsentEvent, and
//     read TrustState as advisory (never blocks — default advisory).
//   - subject with no usable name evidence (extraction pending/failed) → DEFER
//     (not an error; the extraction poll retries). Never create a nameless
//     record.
//
// Cross-client (talent_record / talent_trust / consent) writes follow the
// accepted apps/api-orchestration precedent; the residual create→link duplicate
// window is registered to backlog B1 (the 4th site in that class).

export type PromotionOutcome =
  | { status: 'promoted'; talent_record_id: string; trust_state: TrustStateRow | null }
  | { status: 'already_promoted'; talent_record_id: string }
  | { status: 'deferred_no_name' }
  | { status: 'deferred_no_basis' }
  | { status: 'deferred_unknown_subject' };

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    private readonly trust: TalentTrustService,
    private readonly talentRecords: TalentRecordRepository,
    private readonly sourceConsent: SourceConsentService,
    private readonly ingestion: IngestionRepository,
  ) {}

  async promoteSubject(
    subjectRef: SubjectRef,
    opts?: { requestId?: string },
  ): Promise<PromotionOutcome> {
    const tenant_id = subjectRef.tenant_id;
    const requestId =
      opts?.requestId ?? `promote:${subjectRef.ref_type}:${subjectRef.ref_id}`;

    // 1. Resolve the subject (merge-followed). Unknown ref → nothing to promote.
    const subject = await this.trust.resolveSubjectRef(subjectRef);
    if (subject === null) {
      this.logger.warn(
        `promoteSubject: unknown subject for ref ${subjectRef.ref_type}:${subjectRef.ref_id} (${requestId})`,
      );
      return { status: 'deferred_unknown_subject' };
    }

    // 2. Idempotent no-op — a subject already linked to a record returns it.
    const refs = await this.trust.listSubjectRefs(tenant_id, subject.id);
    const existingRecordRef = refs.find((r) => r.ref_type === 'ATS_TALENT_RECORD');
    if (existingRecordRef !== undefined) {
      return { status: 'already_promoted', talent_record_id: existingRecordRef.ref_id };
    }

    // 3. Gather declared identity evidence → name (required: BOTH parts, the
    //    TalentRecord contract is non-null first_name + last_name) + contact.
    const identity = await this.trust.getEvidence(subjectRef, { dimension: 'IDENTITY' });
    const name = extractName(identity);
    if (name === null) {
      // Extraction pending/failed, or only a partial name — defer (the poll
      // retries). Never mint a nameless/half-named record.
      return { status: 'deferred_no_name' };
    }

    // 4. Legal basis — the origin SOURCED_TALENT arrival carries the source +
    //    captured_at. A promoted record MUST NOT exist without its basis, so a
    //    missing/unmappable basis DEFERS rather than creating an orphan.
    const sourcedRef = refs.find((r) => r.ref_type === 'SOURCED_TALENT');
    if (sourcedRef === undefined) return { status: 'deferred_no_basis' };
    const arrival = await this.ingestion.findById({ id: sourcedRef.ref_id });
    if (arrival === null) return { status: 'deferred_no_basis' };
    const source = arrival.source;
    if (!isConsentSource(source)) {
      this.logger.warn(
        `promoteSubject: arrival source "${source}" is not a consent source type; deferring (${requestId})`,
      );
      return { status: 'deferred_no_basis' };
    }

    // 5. Map the declared identity evidence to the record's PII fields.
    const contact = extractContact(identity);
    const input: CreateTalentRecordRequestDto = {
      first_name: name.first_name,
      last_name: name.last_name,
      ...(contact.email1 !== undefined ? { email1: contact.email1 } : {}),
      ...(contact.phone_cell !== undefined ? { phone_cell: contact.phone_cell } : {}),
      ...(contact.address !== undefined ? { address: contact.address } : {}),
      ...(contact.address2 !== undefined ? { address2: contact.address2 } : {}),
      ...(contact.city !== undefined ? { city: contact.city } : {}),
      ...(contact.state !== undefined ? { state: contact.state } : {}),
      ...(contact.zip !== undefined ? { zip: contact.zip } : {}),
      source,
    };

    // 6. Create the record (system actor — automated promotion, not a human).
    const record = await this.talentRecords.create({
      tenant_id,
      entered_by_id: PROMOTION_SYSTEM_ACTOR_ID,
      input,
      requestId,
    });

    // 7. Link — attach the ATS_TALENT_RECORD ref to THIS subject (idempotent;
    //    UUID-only, no FK). This is the L2→L3 pointer; re-promotion sees it at
    //    step 2 and no-ops.
    await this.trust.attachSubjectRef({
      tenant_id,
      subject_id: subject.id,
      ref_type: 'ATS_TALENT_RECORD',
      ref_id: record.id,
      link_source: PROMOTION_LINK_SOURCE,
    });

    // 8. Reconcile legal basis → L3 TalentConsentEvent keyed to the new record.
    await this.sourceConsent.registerSourceDerivedConsent({
      tenant_id,
      talent_record_id: record.id,
      source,
      occurred_at: arrival.captured_at.toISOString(),
      requestId,
    });

    // 9. Advisory genuineness — read the rollup; attach as context (never block).
    const trust_state = await this.trust.getTrustState(subjectRef);

    this.logger.log(
      `promoteSubject: promoted subject ${subject.id} → TalentRecord ${record.id} (source=${source}, ${requestId})`,
    );
    return { status: 'promoted', talent_record_id: record.id, trust_state };
  }
}

// ---- pure evidence → field mappers (declared THIRD_PARTY_UNVERIFIED) --------

function isConsentSource(source: string): source is ConsentSourceType {
  return (CONSENT_SOURCE_TYPES as readonly string[]).includes(source);
}

// SUPERSEDED / REVOKED / CONTRADICTED / STALE records are not live truth — map
// only currently-valid declared evidence (fresh declared evidence is VALID).
function isLive(e: EvidenceRecordRow): boolean {
  return e.current_status === 'VALID';
}

function payloadOf(e: EvidenceRecordRow): Record<string, unknown> {
  return e.assertion_payload !== null && typeof e.assertion_payload === 'object'
    ? (e.assertion_payload as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length === 0 ? undefined : t;
}

// A named record needs BOTH parts (the DTO contract is non-null). A partial
// name (only first or only last) is NOT promotable → null (defer).
function extractName(
  identity: EvidenceRecordRow[],
): { first_name: string; last_name: string } | null {
  for (const e of identity) {
    if (e.assertion_type !== 'FULL_NAME' || !isLive(e)) continue;
    const p = payloadOf(e);
    const first_name = str(p['first_name']);
    const last_name = str(p['last_name']);
    if (first_name !== undefined && last_name !== undefined) {
      return { first_name, last_name };
    }
  }
  return null;
}

interface ContactFields {
  email1?: string;
  phone_cell?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
}

function extractContact(identity: EvidenceRecordRow[]): ContactFields {
  const out: ContactFields = {};
  for (const e of identity) {
    if (!isLive(e)) continue;
    const p = payloadOf(e);
    if (e.assertion_type === 'EMAIL' && out.email1 === undefined) {
      // recordSourcedArrival anchors write normalized_value; attachContactEvidence
      // writes value — accept either.
      out.email1 = str(p['normalized_value']) ?? str(p['value']);
    } else if (e.assertion_type === 'PHONE' && out.phone_cell === undefined) {
      out.phone_cell = str(p['value']);
    } else if (e.assertion_type === 'ADDRESS' && out.address === undefined) {
      out.address = str(p['address']);
      out.address2 = str(p['address2']);
      out.city = str(p['city']);
      out.state = str(p['state']);
      out.zip = str(p['zip']);
    }
  }
  return out;
}
