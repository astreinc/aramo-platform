import { Injectable, NotFoundException } from '@nestjs/common';

import {
  deriveTrustState,
  type EvidenceForDerivation,
} from './band-derivation.js';
import { deriveStrength } from './strength.js';
import {
  TalentTrustRepository,
  type EvidenceRecordRow,
  type ResolutionSubjectRefRow,
  type ReconcileTargetRow,
  type SubjectAnchorRow,
  type TrustStateRow,
  type ResolutionSubjectRow,
} from './talent-trust.repository.js';
import {
  EVENT_TO_STATUS,
  type AnchorKind,
  type DecayProfile,
  type EvidenceEventType,
  type Method,
  type PortabilityClass,
  type SourceClass,
  type TrustDimension,
  type ResolutionSubjectRefType,
} from './vocab.js';

// TalentTrustService — the §8 interface and the ONLY public surface of TR-1.
//
// Writes append to the immutable ledger; every write recomputes the
// materialized TrustState (never hand-authored, always reconstructible from
// the ledger). Reads return the rollup or the ledger. TR-1 runs no
// verification and makes no accept/reject/sufficiency decision — it records
// and rolls up.

// A reference the resolution index keys against. Holds the ATS TalentRecord.id
// (ATS_TALENT_RECORD — the system-of-record ref / heart), a person-cluster id
// (PERSON_CLUSTER — an index ref), or an ANCHOR.
export interface SubjectRef {
  tenant_id: string;
  ref_type: ResolutionSubjectRefType;
  ref_id: string;
  // Provenance of the link (who/what associated this ref). Defaults to the
  // writing slice when omitted.
  link_source?: string;
}

export interface RecordEvidenceInput {
  subjectRef: SubjectRef;
  dimension: TrustDimension;
  assertion_type: string;
  assertion_payload: unknown;
  source_class: SourceClass;
  method: Method;
  source_ref?: unknown | null;
  portability_class: PortabilityClass;
  decay_profile: DecayProfile;
  // Defaults to now() when omitted.
  collected_at?: Date;
  // Ruling 5 — AI-produced evidence flag. Orthogonal to method. Default false.
  ai_derived?: boolean;
  // The writing slice (TR-2…TR-10).
  created_by: string;
}

// TR-2a-1 — record a within-tenant identifier anchor for the subject resolved
// from an ATS TalentRecord. The producer (apps/api, above the wall) normalizes
// the identifier and calls this; talent_trust imports NOTHING from ats.
export interface RecordAnchorInput {
  tenant_id: string;
  // The ATS TalentRecord.id whose subject the anchor attaches to (resolved via
  // the ATS_TALENT_RECORD ref — the caller passes the id; talent_trust never
  // reads talent-record: the I15 wall).
  talent_record_id: string;
  anchor_kind: AnchorKind;
  // The DETERMINISTICALLY-normalized value (email trim+lowercase / phone
  // digit-strip) — normalized by the caller (@aramo/common), no LLM.
  normalized_value: string;
  // The raw identifier as it appeared on the TalentRecord (provenance, stored
  // in assertion_payload alongside the normalized value).
  raw_source: string;
  // The writing slice — the producer.
  created_by: string;
}

// Fix-Slice-2 — a cold-ingest channel arrival (from libs/canonicalization,
// scope:ats, above the wall). This seam RE-HOMES the retired Core husk's
// within-tenant verified-email resolution onto L2 (ResolutionSubject), composing
// the BUILT TR-2a-1 primitives (findAnchorsByValue + resolveOrCreateSubject +
// insertAnchor + insertEvidence). It is NOT the TR-2 matcher engine — no
// advisory classification, no cross-tenant. Anchor is within-tenant (I4/I14).
export interface RecordSourcedArrivalInput {
  tenant_id: string;
  // The L1 arrival id (ingestion.RawPayloadReference.id) — the SOURCED_TALENT
  // ref_id keying the subject on a MISS (per-arrival provenance, I10).
  payload_id: string;
  // Already normalized at ingestion (trim + lowercase). null when the arrival
  // carried no email (no identity key → always a new subject).
  verified_email: string | null;
  // Unverified contact URL from the payload (nullable). Recorded as evidence,
  // never an identity anchor.
  profile_url: string | null;
  // Provenance — the channel this arrival came from (stored on evidence).
  source_channel: string;
  // The writing slice — 'canonicalization'.
  created_by: string;
}

export interface RecordSourcedArrivalResult {
  subject_id: string;
  // verified_email_match = the normalized-email SubjectAnchor hit an existing
  // subject (Tier-A deterministic same-human, §6A/I5); new_identity = no email
  // match, a new subject was created.
  resolution_method: 'verified_email_match' | 'new_identity';
  // Count of contact EvidenceRecords written this arrival (email + url).
  contact_evidence_written: number;
}

// Cold-Ingest Extraction — one declared evidence fact to attach to a known
// subject (dimension + assertion_type + payload; the source_class/method/decay
// are fixed at THIRD_PARTY_UNVERIFIED/DOCUMENT/SLOW by the writer).
export interface DeclaredEvidenceEntry {
  dimension: TrustDimension;
  assertion_type: string;
  assertion_payload: unknown;
}

@Injectable()
export class TalentTrustService {
  constructor(private readonly repo: TalentTrustRepository) {}

  // ---- Writes: evidence in (§8) --------------------------------------

  async recordEvidence(input: RecordEvidenceInput): Promise<EvidenceRecordRow> {
    const now = new Date();
    const { subjectRef } = input;

    const subjectId = await this.repo.resolveOrCreateSubject(
      subjectRef.tenant_id,
      subjectRef.ref_type,
      subjectRef.ref_id,
      subjectRef.link_source ?? input.created_by,
    );

    // Strength is derived (§6.1), never entered.
    const strength = deriveStrength(input.source_class, input.method);

    const evidence = await this.repo.insertEvidence({
      subject_id: subjectId,
      tenant_id: subjectRef.tenant_id,
      dimension: input.dimension,
      assertion_type: input.assertion_type,
      assertion_payload: input.assertion_payload,
      source_class: input.source_class,
      source_ref: input.source_ref ?? null,
      method: input.method,
      strength,
      collected_at: input.collected_at ?? now,
      decay_profile: input.decay_profile,
      portability_class: input.portability_class,
      ai_derived: input.ai_derived ?? false,
      // current_status is a projection of the latest event; the CREATED event
      // below is that event. VALID = recorded & active.
      current_status: EVENT_TO_STATUS.CREATED,
      created_by: input.created_by,
    });

    await this.repo.appendEvent({
      evidence_id: evidence.id,
      tenant_id: subjectRef.tenant_id,
      event_type: 'CREATED',
      actor: input.created_by,
      occurred_at: now,
    });

    await this.recompute(subjectId, subjectRef.tenant_id, now);
    return evidence;
  }

  // TR-2a-1 — record a within-tenant identifier anchor. Resolves-or-creates the
  // subject via the ATS_TALENT_RECORD ref, then (idempotently) writes the anchor
  // EvidenceRecord (dimension IDENTITY, assertion_type = the anchor kind, the
  // normalized value in assertion_payload — an unverified SELF-declared contact,
  // source_class SELF / method SELF_DECLARED) + its SubjectAnchor projection in
  // ONE transaction, then recomputes TrustState. Re-run safe: if the anchor
  // already exists for this (tenant, subject, kind, value) it is a no-op — so no
  // duplicate evidence and no duplicate projection (write-hook + backfill both
  // converge). Keyed to the ORIGIN subject; never re-homed on merge.
  async recordAnchor(
    input: RecordAnchorInput,
  ): Promise<{ evidence: EvidenceRecordRow; anchor: SubjectAnchorRow } | null> {
    const now = new Date();
    const subjectId = await this.repo.resolveOrCreateSubject(
      input.tenant_id,
      'ATS_TALENT_RECORD',
      input.talent_record_id,
      input.created_by,
    );

    // Idempotency gate — exists-check BEFORE writing evidence (resolve-or-create
    // dedupes the subject; this dedupes the anchor + its evidence).
    const existing = await this.repo.findSubjectAnchor(
      input.tenant_id,
      subjectId,
      input.anchor_kind,
      input.normalized_value,
    );
    if (existing !== null) return null;

    const strength = deriveStrength('SELF', 'SELF_DECLARED');
    const written = await this.repo.insertAnchor({
      evidence: {
        subject_id: subjectId,
        tenant_id: input.tenant_id,
        dimension: 'IDENTITY',
        assertion_type: input.anchor_kind,
        assertion_payload: {
          normalized_value: input.normalized_value,
          raw_source: input.raw_source,
        },
        source_class: 'SELF',
        method: 'SELF_DECLARED',
        strength,
        collected_at: now,
        // Contact identifiers drift (job change, new number) — SLOW, not DURABLE.
        decay_profile: 'SLOW',
        portability_class: 'TENANT_ONLY',
        ai_derived: false,
        current_status: EVENT_TO_STATUS.CREATED,
        created_by: input.created_by,
      },
      anchor_kind: input.anchor_kind,
      normalized_value: input.normalized_value,
    });

    await this.recompute(subjectId, input.tenant_id, now);
    return written;
  }

  // Fix-Slice-2 — resolve a cold-ingest arrival's within-tenant ResolutionSubject
  // and attach its per-arrival contact evidence. RE-HOMES the husk's verified-email
  // resolution (`talentContactMethod.findFirst(verified)` → husk id) onto L2:
  //   - verified_email present → look up the normalized-email SubjectAnchor
  //     (deterministic, oldest wins — mirrors the husk's orderBy created_at asc):
  //       * HIT  → resolve to that subject (verified_email_match, Tier-A §6A/I5);
  //       * MISS → create a subject keyed by the SOURCED_TALENT ref (payload_id)
  //                and record the email SubjectAnchor (new_identity).
  //   - no verified_email → a new subject keyed by the SOURCED_TALENT ref.
  // Contact evidence (email observation on a hit, profile_url) attaches to the
  // resolved subject with the arrival's provenance (payload_id + source_channel);
  // channel-sourced ⇒ THIRD_PARTY_UNVERIFIED / DOCUMENT, tenant-walled (I8).
  async recordSourcedArrival(
    input: RecordSourcedArrivalInput,
  ): Promise<RecordSourcedArrivalResult> {
    const now = new Date();
    let subjectId: string;
    let resolution_method: RecordSourcedArrivalResult['resolution_method'];
    let contactWritten = 0;

    if (input.verified_email !== null) {
      const anchors = await this.repo.findAnchorsByValue(
        input.tenant_id,
        'EMAIL',
        input.verified_email,
      );
      if (anchors.length > 0) {
        // Deterministic: the oldest anchor's origin subject wins (mirrors the
        // retired husk's `orderBy created_at asc`).
        const oldest = anchors.reduce((a, b) => (a.created_at <= b.created_at ? a : b));
        subjectId = oldest.subject_id;
        resolution_method = 'verified_email_match';
        // Per-arrival email observation (I10 attributability). The anchor already
        // exists (that is how we matched) — this is evidence, not a new anchor.
        await this.attachContactEvidence(
          subjectId,
          input,
          'EMAIL',
          input.verified_email,
          now,
        );
        contactWritten += 1;
      } else {
        subjectId = await this.repo.resolveOrCreateSubject(
          input.tenant_id,
          'SOURCED_TALENT',
          input.payload_id,
          input.created_by,
        );
        resolution_method = 'new_identity';
        // Record the email SubjectAnchor (writes its source EvidenceRecord +
        // the anchor projection in one tx). Exists-checked for re-run safety.
        const existing = await this.repo.findSubjectAnchor(
          input.tenant_id,
          subjectId,
          'EMAIL',
          input.verified_email,
        );
        if (existing === null) {
          const strength = deriveStrength('THIRD_PARTY_UNVERIFIED', 'DOCUMENT');
          await this.repo.insertAnchor({
            evidence: {
              subject_id: subjectId,
              tenant_id: input.tenant_id,
              dimension: 'IDENTITY',
              assertion_type: 'EMAIL',
              assertion_payload: {
                normalized_value: input.verified_email,
                source_channel: input.source_channel,
                payload_id: input.payload_id,
              },
              source_class: 'THIRD_PARTY_UNVERIFIED',
              method: 'DOCUMENT',
              strength,
              collected_at: now,
              decay_profile: 'SLOW',
              portability_class: 'TENANT_ONLY',
              ai_derived: false,
              current_status: EVENT_TO_STATUS.CREATED,
              created_by: input.created_by,
            },
            anchor_kind: 'EMAIL',
            normalized_value: input.verified_email,
          });
          contactWritten += 1;
        }
      }
    } else {
      subjectId = await this.repo.resolveOrCreateSubject(
        input.tenant_id,
        'SOURCED_TALENT',
        input.payload_id,
        input.created_by,
      );
      resolution_method = 'new_identity';
    }

    // profile_url — an unverified contact evidence (never an identity anchor).
    if (input.profile_url !== null) {
      await this.attachContactEvidence(subjectId, input, 'PROFILE_URL', input.profile_url, now);
      contactWritten += 1;
    }

    await this.recompute(subjectId, input.tenant_id, now);
    return { subject_id: subjectId, resolution_method, contact_evidence_written: contactWritten };
  }

  // Attach one per-arrival contact EvidenceRecord (+ CREATED event) to a resolved
  // subject. Channel-sourced ⇒ THIRD_PARTY_UNVERIFIED / DOCUMENT; IDENTITY dim;
  // provenance (payload_id + source_channel) travels in the assertion_payload.
  private async attachContactEvidence(
    subjectId: string,
    input: RecordSourcedArrivalInput,
    assertionType: 'EMAIL' | 'PROFILE_URL',
    value: string,
    now: Date,
  ): Promise<void> {
    const strength = deriveStrength('THIRD_PARTY_UNVERIFIED', 'DOCUMENT');
    const evidence = await this.repo.insertEvidence({
      subject_id: subjectId,
      tenant_id: input.tenant_id,
      dimension: 'IDENTITY',
      assertion_type: assertionType,
      assertion_payload: {
        value,
        source_channel: input.source_channel,
        payload_id: input.payload_id,
      },
      source_class: 'THIRD_PARTY_UNVERIFIED',
      method: 'DOCUMENT',
      strength,
      collected_at: now,
      decay_profile: 'SLOW',
      portability_class: 'TENANT_ONLY',
      ai_derived: false,
      current_status: EVENT_TO_STATUS.CREATED,
      created_by: input.created_by,
    });
    await this.repo.appendEvent({
      evidence_id: evidence.id,
      tenant_id: input.tenant_id,
      event_type: 'CREATED',
      actor: input.created_by,
      occurred_at: now,
    });
  }

  // Cold-Ingest Extraction — write declared evidence to an ALREADY-RESOLVED
  // subject (the arrival's resolved_subject_id), NOT resolve-by-ref: the caller
  // holds the subject id (a re-arrival matched by email carries no per-payload
  // SOURCED_TALENT ref, so resolve-by-ref would mint a wrong subject). All
  // entries are channel-sourced declared evidence — THIRD_PARTY_UNVERIFIED /
  // DOCUMENT, never SELF, never verified (ADR-0015 guardrail 3: structuring a
  // claim is not verification). One TrustState recompute after the batch.
  async recordDeclaredEvidenceForSubject(input: {
    tenant_id: string;
    subject_id: string;
    entries: DeclaredEvidenceEntry[];
    created_by: string;
  }): Promise<{ evidence_ids: string[] }> {
    const now = new Date();
    const strength = deriveStrength('THIRD_PARTY_UNVERIFIED', 'DOCUMENT');
    const evidence_ids: string[] = [];
    for (const e of input.entries) {
      const evidence = await this.repo.insertEvidence({
        subject_id: input.subject_id,
        tenant_id: input.tenant_id,
        dimension: e.dimension,
        assertion_type: e.assertion_type,
        assertion_payload: e.assertion_payload,
        source_class: 'THIRD_PARTY_UNVERIFIED',
        method: 'DOCUMENT',
        strength,
        collected_at: now,
        decay_profile: 'SLOW',
        portability_class: 'TENANT_ONLY',
        ai_derived: false,
        current_status: EVENT_TO_STATUS.CREATED,
        created_by: input.created_by,
      });
      await this.repo.appendEvent({
        evidence_id: evidence.id,
        tenant_id: input.tenant_id,
        event_type: 'CREATED',
        actor: input.created_by,
        occurred_at: now,
      });
      evidence_ids.push(evidence.id);
    }
    if (evidence_ids.length > 0) {
      await this.recompute(input.subject_id, input.tenant_id, now);
    }
    return { evidence_ids };
  }

  // ---- Writes: lifecycle ops (§8) ------------------------------------
  // Each appends an EvidenceEvent (+ EvidenceLink where relational), projects
  // the new current_status, and recomputes TrustState.

  async markStale(evidenceId: string): Promise<void> {
    await this.applyLifecycle(evidenceId, 'MARKED_STALE', {});
  }

  async revoke(evidenceId: string, reason: string): Promise<void> {
    await this.applyLifecycle(evidenceId, 'REVOKED', { reason });
  }

  async contradict(evidenceId: string, byEvidenceId: string, reason: string): Promise<void> {
    const ev = await this.requireEvidence(evidenceId);
    await this.repo.appendLink({
      from_evidence_id: byEvidenceId,
      to_evidence_id: evidenceId,
      relation: 'CONTRADICTS',
      tenant_id: ev.tenant_id,
    });
    await this.applyLifecycle(evidenceId, 'CONTRADICTED', {
      reason,
      linked_evidence_id: byEvidenceId,
      evidence: ev,
    });
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    const ev = await this.requireEvidence(oldId);
    await this.repo.appendLink({
      from_evidence_id: newId,
      to_evidence_id: oldId,
      relation: 'SUPERSEDES',
      tenant_id: ev.tenant_id,
    });
    await this.applyLifecycle(oldId, 'SUPERSEDED', { linked_evidence_id: newId, evidence: ev });
  }

  async dispute(evidenceId: string, reason: string): Promise<void> {
    await this.applyLifecycle(evidenceId, 'DISPUTED', { reason });
  }

  async resolveDispute(evidenceId: string, outcome: string): Promise<void> {
    await this.applyLifecycle(evidenceId, 'DISPUTE_RESOLVED', { reason: outcome });
  }

  // ---- Subject capability (§8) — reversible; logic deferred to TR-6 ---

  async mergeSubjects(
    survivingSubjectId: string,
    mergedSubjectId: string,
    reason: string,
  ): Promise<ResolutionSubjectRow> {
    await this.requireSubject(survivingSubjectId);
    await this.requireSubject(mergedSubjectId);
    // `reason` is part of the §8 merge contract; TR-1 ships the reversible
    // capability only (mark, never delete — the immutable ledger is
    // untouched). TR-6 supplies the WHEN, the evidence reconciliation, and the
    // merge-audit persistence the reason will feed.
    void reason;
    return this.repo.setSubjectMergeState(mergedSubjectId, 'MERGED', survivingSubjectId);
  }

  async unmergeSubjects(mergedSubjectId: string, reason: string): Promise<ResolutionSubjectRow> {
    await this.requireSubject(mergedSubjectId);
    void reason; // See mergeSubjects — reason persistence is deferred to TR-6.
    return this.repo.setSubjectMergeState(mergedSubjectId, 'ACTIVE', null);
  }

  // ---- Reads: state out (§8) -----------------------------------------

  async getTrustState(subjectRef: SubjectRef): Promise<TrustStateRow | null> {
    const subject = await this.resolveSubjectForRead(subjectRef);
    if (subject === null) return null;

    const persisted = await this.repo.findTrustStateBySubject(subject.id);
    if (persisted) return persisted;

    // Subject exists but carries no evidence yet — synthesize the empty
    // rollup so callers always receive four bands.
    return {
      subject_id: subject.id,
      tenant_id: subject.tenant_id,
      identity_band: 'NOT_ESTABLISHED',
      claims_band: 'NOT_ESTABLISHED',
      continuity_band: 'NOT_ESTABLISHED',
      eligibility_band: 'NOT_ESTABLISHED',
      open_contradiction_count: 0,
      stale_evidence_count: 0,
      has_open_dispute: false,
      last_recomputed_at: subject.created_at,
    };
  }

  async getEvidence(
    subjectRef: SubjectRef,
    filters?: Parameters<TalentTrustRepository['listEvidenceBySubject']>[1],
  ): Promise<EvidenceRecordRow[]> {
    const subject = await this.resolveSubjectForRead(subjectRef);
    if (subject === null) return [];
    return this.repo.listEvidenceBySubject(subject.id, filters);
  }

  // ---- Promotion Gate reads/link (Slice A) ----------------------------
  // These three compose the L2→L3 create branch (the orchestration lives in
  // apps/api, above the I15 wall; talent_trust imports NO ats). resolveSubjectRef
  // exposes the merge-followed subject id; listSubjectRefs backs the
  // already-promoted no-op + the origin-arrival lookup; attachSubjectRef links
  // the subject to the freshly-minted TalentRecord.

  // Resolve a subjectRef to its (merge-followed) subject. Public wrapper of the
  // read-resolver so apps/api can get subject_id without re-deriving it.
  async resolveSubjectRef(subjectRef: SubjectRef): Promise<ResolutionSubjectRow | null> {
    return this.resolveSubjectForRead(subjectRef);
  }

  async listSubjectRefs(
    tenantId: string,
    subjectId: string,
  ): Promise<ResolutionSubjectRefRow[]> {
    return this.repo.listRefsBySubject(subjectId);
  }

  // Attach a ref (e.g. ATS_TALENT_RECORD → newRecord.id) to an existing subject.
  // Idempotent (repo dedupes on tenant+ref_type+ref_id). NOT resolveOrCreate:
  // the subject is known; this points a new ref at it (the promotion link).
  async attachSubjectRef(input: {
    tenant_id: string;
    subject_id: string;
    ref_type: ResolutionSubjectRefType;
    ref_id: string;
    link_source: string;
  }): Promise<void> {
    await this.repo.attachRef(input);
  }

  // ---- Promotion Gate Slice-B1 — reconcile poll (enrich-only) ----------
  // The reconcile processor (apps/api, above the wall) drives these: find
  // promoted subjects with newer evidence, then stamp/bump the watermark. The
  // enrichment READ uses the existing getEvidence(subjectRef) — no new read.

  async findSubjectsNeedingReconcile(args: {
    limit: number;
    maxAttempts: number;
  }): Promise<ReconcileTargetRow[]> {
    return this.repo.findSubjectsNeedingReconcile(args);
  }

  async markReconciled(subjectId: string): Promise<void> {
    await this.repo.markReconciled(subjectId);
  }

  async bumpReconcileAttempt(subjectId: string): Promise<void> {
    await this.repo.bumpReconcileAttempt(subjectId);
  }

  // ---- internals ------------------------------------------------------

  private async applyLifecycle(
    evidenceId: string,
    eventType: EvidenceEventType,
    opts: {
      reason?: string;
      linked_evidence_id?: string;
      actor?: string;
      // Pre-fetched record (callers that already loaded it pass it through).
      evidence?: EvidenceRecordRow;
    },
  ): Promise<void> {
    const ev = opts.evidence ?? (await this.requireEvidence(evidenceId));
    const now = new Date();

    await this.repo.appendEvent({
      evidence_id: evidenceId,
      tenant_id: ev.tenant_id,
      event_type: eventType,
      reason: opts.reason ?? null,
      linked_evidence_id: opts.linked_evidence_id ?? null,
      actor: opts.actor ?? null,
      occurred_at: now,
    });

    // current_status is set ONLY by applying an event (§5.5) — this is the
    // projection of the latest event.
    await this.repo.updateEvidenceStatus(evidenceId, EVENT_TO_STATUS[eventType]);

    await this.recompute(ev.subject_id, ev.tenant_id, now);
  }

  // Recompute the materialized TrustState from the full ledger. Never
  // hand-authored — always reconstructible from evidence + events.
  private async recompute(subjectId: string, tenantId: string, now: Date): Promise<void> {
    const evidence = await this.repo.listEvidenceBySubject(subjectId);
    const projection: EvidenceForDerivation[] = evidence.map((e) => ({
      dimension: e.dimension,
      source_class: e.source_class,
      method: e.method,
      strength: e.strength,
      current_status: e.current_status,
      decay_profile: e.decay_profile,
      collected_at: e.collected_at,
      source_ref: e.source_ref,
    }));

    const derived = deriveTrustState(projection, now);
    await this.repo.upsertTrustState({
      subject_id: subjectId,
      tenant_id: tenantId,
      ...derived,
      last_recomputed_at: now,
    });
  }

  private async resolveSubjectForRead(subjectRef: SubjectRef): Promise<ResolutionSubjectRow | null> {
    const subject = await this.repo.findSubjectByRef(
      subjectRef.tenant_id,
      subjectRef.ref_type,
      subjectRef.ref_id,
    );
    if (subject === null) return null;
    // Follow a merge pointer to the surviving subject (R6).
    if (subject.status === 'MERGED' && subject.merged_into_subject_id !== null) {
      return this.repo.findSubjectById(subject.merged_into_subject_id);
    }
    return subject;
  }

  private async requireEvidence(evidenceId: string): Promise<EvidenceRecordRow> {
    const ev = await this.repo.findEvidenceById(evidenceId);
    if (ev === null) {
      throw new NotFoundException(`EvidenceRecord ${evidenceId} not found`);
    }
    return ev;
  }

  private async requireSubject(subjectId: string): Promise<ResolutionSubjectRow> {
    const subject = await this.repo.findSubjectById(subjectId);
    if (subject === null) {
      throw new NotFoundException(`ResolutionSubject ${subjectId} not found`);
    }
    return subject;
  }
}
