import { Injectable, Logger } from '@nestjs/common';
import {
  CONSENT_SOURCE_TYPES,
  SourceConsentService,
  type ConsentSourceType,
} from '@aramo/consent';
import { IngestionRepository } from '@aramo/ingestion';
import {
  TalentRecordRepository,
  TalentRecordReconcileRepository,
  type CreateTalentRecordRequestDto,
} from '@aramo/talent-record';
import {
  TalentTrustService,
  TalentTrustRepository,
  type EvidenceRecordRow,
  type SubjectRef,
  type TrustStateRow,
} from '@aramo/talent-trust';

import {
  PROMOTION_LINK_SOURCE,
  PROMOTION_SOURCED_STATUS,
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
  | { status: 'deferred_unknown_subject' }
  // Promotion-Trigger slice-A — the identity gate: the subject has an
  // unresolved (PENDING_REVIEW) merge advisory ("might be the same human as
  // another subject"). Block the mint until identity is settled (a human
  // resolves the advisory). NOT an attribute contradiction (those ride onto
  // the record) — this is identity-not-settled.
  | { status: 'deferred_unresolved_identity' };

@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    private readonly trust: TalentTrustService,
    private readonly trustRepo: TalentTrustRepository,
    private readonly talentRecords: TalentRecordRepository,
    private readonly reconcileRepo: TalentRecordReconcileRepository,
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

    // 2.5. Identity gate (Promotion-Trigger slice-A) — block the mint if the
    //    subject has an UNRESOLVED merge advisory ("might be the same human as
    //    another subject"). Identity must be settled before a record exists, so
    //    two live records never key to one human. Read-only check against the
    //    TR-2a advisory ledger (does NOT rebuild resolution — that is TR-2).
    //    Attribute contradictions (name/phone) do NOT block here — they ride
    //    onto the record as the sourcer's clean-up queue (B1/B2).
    const openAdvisories = await this.trustRepo.listMatchAdvisories(tenant_id, {
      subjectId: subject.id,
      status: 'PENDING_REVIEW',
    });
    if (openAdvisories.length > 0) {
      this.logger.warn(
        `promoteSubject: subject ${subject.id} has ${openAdvisories.length} unresolved merge advisory(ies); deferring (${requestId})`,
      );
      return { status: 'deferred_unresolved_identity' };
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
    const f = contact.fields;
    const input: CreateTalentRecordRequestDto = {
      first_name: name.first_name,
      last_name: name.last_name,
      ...(f.email1 !== undefined ? { email1: f.email1 } : {}),
      ...(f.phone_cell !== undefined ? { phone_cell: f.phone_cell } : {}),
      ...(f.address !== undefined ? { address: f.address } : {}),
      ...(f.address2 !== undefined ? { address2: f.address2 } : {}),
      ...(f.city !== undefined ? { city: f.city } : {}),
      ...(f.state !== undefined ? { state: f.state } : {}),
      ...(f.zip !== undefined ? { zip: f.zip } : {}),
      source,
    };

    // 6. Create the record (system actor — automated promotion, not a human).
    //    Lands at tenant_status='sourced' (un-worked); a recruiter working it in
    //    L3 flips it to 'engaged' (deferred to its own slice).
    const record = await this.talentRecords.create({
      tenant_id,
      entered_by_id: PROMOTION_SYSTEM_ACTOR_ID,
      input,
      requestId,
      tenant_status: PROMOTION_SOURCED_STATUS,
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

    // 7.5. Create-path provenance (Slice-B2 back-fill invariant) — record which
    //    EvidenceRecord each set field projects, so B2's pending → provenance →
    //    incumbent join always resolves (a field set here and later contradicted
    //    at the FIRST reconcile would otherwise have no incumbent). Best-effort:
    //    the record is already created + linked; a provenance write failure is
    //    self-healed by B1's occupied-same align on the next reconcile. Same
    //    talent_record schema as the record (not cross-client); residual write
    //    failure registered to backlog B1.
    const provenance: FieldEvidence[] = [
      { field_name: 'first_name', evidence_id: name.evidence_id },
      { field_name: 'last_name', evidence_id: name.evidence_id },
      ...contact.provenance,
    ];
    try {
      for (const pr of provenance) {
        await this.reconcileRepo.upsertFieldProvenance({
          tenant_id,
          talent_record_id: record.id,
          field_name: pr.field_name,
          evidence_id: pr.evidence_id,
        });
      }
    } catch (err) {
      this.logger.warn(
        `promoteSubject: create-path provenance write failed for record ${record.id} (${requestId}); B1 reconcile will back-fill: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

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

// Slice-B2 — the (field_name → source EvidenceRecord.id) provenance a create
// projects. The value came FROM this evidence; the back-fill invariant records
// it so B2's pending-row → provenance → incumbent join always resolves.
interface FieldEvidence {
  field_name: string;
  evidence_id: string;
}

// A named record needs BOTH parts (the DTO contract is non-null). A partial
// name (only first or only last) is NOT promotable → null (defer). Carries the
// FULL_NAME EvidenceRecord.id so create writes first_name/last_name provenance.
function extractName(
  identity: EvidenceRecordRow[],
): { first_name: string; last_name: string; evidence_id: string } | null {
  for (const e of identity) {
    if (e.assertion_type !== 'FULL_NAME' || !isLive(e)) continue;
    const p = payloadOf(e);
    const first_name = str(p['first_name']);
    const last_name = str(p['last_name']);
    if (first_name !== undefined && last_name !== undefined) {
      return { first_name, last_name, evidence_id: e.id };
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

// Returns the mapped contact fields AND, per field actually set, the source
// EvidenceRecord.id (create-path provenance; the field_names match B1's so B2's
// join is uniform). ADDRESS sub-fields share their one ADDRESS evidence.
function extractContact(identity: EvidenceRecordRow[]): {
  fields: ContactFields;
  provenance: FieldEvidence[];
} {
  const fields: ContactFields = {};
  const provenance: FieldEvidence[] = [];
  const set = (field_name: keyof ContactFields, value: string | undefined, evidence_id: string): void => {
    if (value === undefined) return;
    fields[field_name] = value;
    provenance.push({ field_name, evidence_id });
  };
  for (const e of identity) {
    if (!isLive(e)) continue;
    const p = payloadOf(e);
    if (e.assertion_type === 'EMAIL' && fields.email1 === undefined) {
      // recordSourcedArrival anchors write normalized_value; attachContactEvidence
      // writes value — accept either.
      set('email1', str(p['normalized_value']) ?? str(p['value']), e.id);
    } else if (e.assertion_type === 'PHONE' && fields.phone_cell === undefined) {
      set('phone_cell', str(p['value']), e.id);
    } else if (e.assertion_type === 'ADDRESS' && fields.address === undefined) {
      set('address', str(p['address']), e.id);
      set('address2', str(p['address2']), e.id);
      set('city', str(p['city']), e.id);
      set('state', str(p['state']), e.id);
      set('zip', str(p['zip']), e.id);
    }
  }
  return { fields, provenance };
}
