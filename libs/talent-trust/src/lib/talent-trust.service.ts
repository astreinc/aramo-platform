import { createHash } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AramoError, hashCanonicalizedBody } from '@aramo/common';

import { isConfirmingAnchor } from './anchor-confirmation.js';
import { validateClaimShape, attesterDescriptorKey } from './canonical-claim-shapes.js';
import {
  computeConsistencyPlan,
  detectAttesterIdentityOverlap,
  REASON_ATTESTER_IDENTITY_OVERLAP,
  REASON_EMPLOYER_CONFLICT_SAME_WINDOW,
  REASON_IMPOSSIBLE_RANGE,
  type AttestationClaim,
  type EmploymentClaim,
  type ExistingGap,
} from './consistency-detectors.js';
import {
  computeContinuityDerivations,
  CONTACT_ANCHOR_KINDS,
  HISTORY_SPAN,
  LONGITUDINAL_PRESENCE,
  type ContactObservation,
  type DerivedAction,
  type ExistingDerived,
  type HistorySpanPayload,
  type LongitudinalPresencePayload,
} from './continuity-derivers.js';
import {
  deriveTrustState,
  VERIFICATION_STALE_DAYS,
  type EvidenceForDerivation,
} from './band-derivation.js';
import { namesFlatlyConflict } from './name-guard.js';
import {
  generateProposals,
  type OpenContradiction,
  type VerificationSlot,
} from './proposal-generator.js';
import { deriveStrength } from './strength.js';
import {
  SubjectMatcherService,
  type CorroboratorConflictsByTarget,
} from './subject-matcher.service.js';
import {
  TalentTrustRepository,
  type EvidenceRecordRow,
  type EvidenceLinkRow,
  type EvidenceEventRow,
  type ResolutionSubjectRefRow,
  type ReconcileTargetRow,
  type SubjectAnchorRow,
  type SubjectMergeOperationRow,
  type TrustStateRow,
  type ResolutionSubjectRow,
  type VerificationProposalRow,
  type VerificationRequestRow,
  type PortalDisputeRow,
  type PortalDisputeStatementRow,
  type PortalDisputeWorkItemRow,
} from './talent-trust.repository.js';
import {
  mintPortalVerificationItemId,
  portalVerificationItemIdMatches,
} from './portal-verification-item-id.js';
import {
  EVENT_TO_STATUS,
  PORTAL_DISPUTE_OPEN_STATES,
  PORTAL_DISPUTE_SLA,
  PORTAL_DISPUTE_WORK_ITEM_STATES,
  PROPOSAL_SETTLED_JUSTIFICATION,
  SOURCE_CLASSES,
  type AnchorKind,
  type CorroboratorConflictKind,
  type PortalDisputeItemType,
  type DecayProfile,
  type EvidenceEventType,
  type EvidenceStatus,
  type Method,
  type PortabilityClass,
  type ProposalKind,
  type ProposalStatus,
  type SourceClass,
  type TrustDimension,
  type ResolutionSubjectRefType,
} from './vocab.js';

// TR-12 B1 — days→ms for the verification-staleness threshold (mirrors the
// band-derivation constant; the flag uses the same 365d rule).
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
  // NOTE (DDR-1 §3.3): `verified_email` is a documented misnomer — the value is
  // channel-CLAIMED, not verified. Its verification level is carried by
  // `source_class` below, never by this field's name.
  verified_email: string | null;
  // Unverified contact URL from the payload (nullable). Recorded as evidence,
  // never an identity anchor.
  profile_url: string | null;
  // Provenance — the channel this arrival came from (stored on evidence).
  source_channel: string;
  // TR-2a-B1 (DDR-1 §3.1) — the arrival's attestation level, SERVER-derived in
  // the ingestion adapter and read off the payload row (never caller-supplied).
  // Threaded onto the per-arrival contact evidence and the minted email anchor.
  // The resolve DECISION does not read it in B1 (that is B2 — this slice only
  // records it on the evidence/anchor writes, replacing the old hard-coded
  // THIRD_PARTY_UNVERIFIED literals).
  source_class: SourceClass;
  // TR-2a-B2 (Name-Wiring §1) — the channel-supplied declared name CLAIM
  // (nullable). Consumed ONLY by the CONFIRMED-arm NAME guard (Amendment §2.2);
  // never an identity key, never persisted as evidence in this slice. Absence
  // never conflicts.
  declared_name: string | null;
  // The writing slice — 'canonicalization'.
  created_by: string;
  // TR-2b B1 PR-2 (DDR R4) — the PERSON_CLUSTER id this arrival was admitted to
  // (the cross-tenant index cluster), or null when nothing was admitted (no
  // verified email under PORTABLE_ONLY, or the policy gate did not admit). When
  // non-null, a PERSON_CLUSTER ResolutionSubjectRef is written to the resolved
  // subject — the tenant-side, queryable pointer INTO identity_index (the I14
  // wall governs what is IN the index, not what points AT it). Ref only when a
  // cluster was actually admitted — no ref without a mint.
  cluster_id: string | null;
}

export interface RecordSourcedArrivalResult {
  subject_id: string;
  // TR-2a-B2 (DDR-2 §2/§6) — the WRITABLE method set: confirmed_anchor_match = a
  // deterministic Tier-A both-sides-confirming resolve (single ACTIVE target,
  // NAME guard passed); new_identity = everything else (split/ambiguity/unresolved
  // + a NAME-demoted confirming hit). verified_email_match is retired from the
  // writable set (its name asserted a verification that never occurred).
  resolution_method: 'confirmed_anchor_match' | 'new_identity';
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

// TR-4 B1 — the claim-shape gate is a lib-internal invariant (no HTTP request in
// its call paths today — recordEvidence has no production caller;
// recordDeclaredEvidenceForSubject runs in the cold-ingest processor). A constant
// request-id sentinel labels the AramoError envelope (the loadMailerConfig
// precedent); a real controller in a later slice would pass its own.
const CLAIM_SHAPE_REQUEST_ID = 'talent-trust-claim-shape';

@Injectable()
export class TalentTrustService {
  private readonly logger = new Logger(TalentTrustService.name);

  // TR-2a-B2 (DDR-2 §3) — the resolver→matcher hand-off is intra-module DI:
  // TalentTrustService gains SubjectMatcherService (both talent_trust providers,
  // acyclic — the matcher does NOT depend on this service). No new @aramo/* edge.
  constructor(
    private readonly repo: TalentTrustRepository,
    private readonly matcher: SubjectMatcherService,
  ) {}

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

    // TR-4 B1 (DDR §2.2) — a REGISTERED assertion_type must carry its canonical
    // shape; an unregistered type passes through untouched. Refuses (422) here,
    // before any write.
    const canonicalPayload = this.canonicalizeOrRefuse(
      input.assertion_type,
      input.assertion_payload,
    );

    const evidence = await this.repo.insertEvidence({
      subject_id: subjectId,
      tenant_id: subjectRef.tenant_id,
      dimension: input.dimension,
      assertion_type: input.assertion_type,
      assertion_payload: canonicalPayload,
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
      // The ATS producer path is definitionally SELF (DDR-1 §4). A value already
      // anchored at a different class would be a distinct append-only row.
      'SELF',
    );
    if (existing !== null) return null;

    const strength = deriveStrength('SELF', 'SELF_DECLARED');
    const written = await this.repo.insertAnchor({
      evidence: {
        subject_id: subjectId,
        tenant_id: input.tenant_id,
        dimension: 'IDENTITY',
        assertion_type: input.anchor_kind,
        // TR-4 B1 (DDR §2.3) — canonical contact key is `value` (the normalized
        // identifier); the raw is preserved beside it. Converged forward from the
        // legacy `normalized_value` key (the canary readers dual-read both).
        assertion_payload: {
          value: input.normalized_value,
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

  // TR-3 B2 (§3.2) — CONFIRM: the one atomic method behind the public confirm
  // route. Given the sha256-at-rest token_hash (the apps/api confirm controller
  // hashes the presented raw token with the flow's local util), this:
  //   1. CONSUMES the request — a single guarded UPDATE (repo) claims it,
  //      flipping PENDING→CONFIRMED + stamping consumed_at, ONLY if still live.
  //      The replay guard IS this UPDATE: a second confirm (or a rotated/expired
  //      /bad token) matches zero rows → { verified:false }. The caller maps
  //      EVERY false to one indistinguishable not-found (oracle-resistance).
  //   2. MINTS the PLATFORM_VERIFIED EMAIL anchor (new row per the 5-field key)
  //      — dimension IDENTITY, assertion_type EMAIL_CONTROL_VERIFIED, method
  //      CONTROL_ROUND_TRIP (strength 0.7), ai_derived:false, created_by
  //      'verification' — beside any unverified SELF row for the same value.
  //      Exists-checked at PLATFORM_VERIFIED so a (belt-and-braces) re-entry
  //      never violates the unique key.
  //   3. RECOMPUTES TrustState → IDENTITY lifts to CORROBORATED, and the TR-6
  //      watermark re-selects the subject on its next poll (no extra wiring).
  // It performs NO subject resolve/merge (DDR §5 — confirm never auto-resolves).
  async confirmEmailVerification(
    tokenHash: string,
  ): Promise<{ verified: boolean; subject_id?: string; tenant_id?: string }> {
    const now = new Date();
    const claimed = await this.repo.consumeVerificationRequest(tokenHash, now);
    if (claimed === null) return { verified: false };

    const existing = await this.repo.findSubjectAnchor(
      claimed.tenant_id,
      claimed.subject_id,
      claimed.anchor_kind,
      claimed.normalized_value,
      'PLATFORM_VERIFIED',
    );
    if (existing === null) {
      const strength = deriveStrength('PLATFORM_VERIFIED', 'CONTROL_ROUND_TRIP');
      await this.repo.insertAnchor({
        evidence: {
          subject_id: claimed.subject_id,
          tenant_id: claimed.tenant_id,
          dimension: 'IDENTITY',
          // EMAIL → EMAIL_CONTROL_VERIFIED (the OPEN-6 IDENTITY registry name);
          // PHONE reserved for TR-3 v2 (v1 mints EMAIL only, per the request gate).
          assertion_type:
            claimed.anchor_kind === 'EMAIL'
              ? 'EMAIL_CONTROL_VERIFIED'
              : 'PHONE_CONTROL_VERIFIED',
          assertion_payload: {
            normalized_value: claimed.normalized_value,
            verification_request_id: claimed.id,
          },
          source_class: 'PLATFORM_VERIFIED',
          method: 'CONTROL_ROUND_TRIP',
          strength,
          collected_at: now,
          decay_profile: 'SLOW',
          portability_class: 'TENANT_ONLY',
          ai_derived: false,
          current_status: EVENT_TO_STATUS.CREATED,
          created_by: 'verification',
        },
        anchor_kind: claimed.anchor_kind,
        normalized_value: claimed.normalized_value,
      });
    } else {
      // TR-8 D1 (DDR) — RENEWAL of an already-verified slot: the anchor STANDS
      // (dedup semantics unchanged — it asserts the identity linkage), but the
      // verification ACT is re-made. Mint a FRESH EMAIL_CONTROL_VERIFIED evidence
      // (fresh collected_at → the SLOW decay clock restarts) and SUPERSEDE the
      // prior current verification evidence (the TR-5 replace pattern — one
      // current verification truth; the superseded act stays in history). The
      // superseded row's status change (via supersede) plus the fresh VALID row
      // are what a recompute prices; verified_control_stale clears next recompute.
      const assertionType =
        claimed.anchor_kind === 'EMAIL' ? 'EMAIL_CONTROL_VERIFIED' : 'PHONE_CONTROL_VERIFIED';
      const priorId = await this.findCurrentVerificationEvidence(
        claimed.subject_id,
        assertionType,
        claimed.normalized_value,
      );
      const fresh = await this.repo.insertEvidence({
        subject_id: claimed.subject_id,
        tenant_id: claimed.tenant_id,
        dimension: 'IDENTITY',
        assertion_type: assertionType,
        assertion_payload: {
          normalized_value: claimed.normalized_value,
          verification_request_id: claimed.id,
        },
        source_class: 'PLATFORM_VERIFIED',
        method: 'CONTROL_ROUND_TRIP',
        strength: deriveStrength('PLATFORM_VERIFIED', 'CONTROL_ROUND_TRIP'),
        source_ref: null,
        collected_at: now,
        decay_profile: 'SLOW',
        portability_class: 'TENANT_ONLY',
        ai_derived: false,
        current_status: EVENT_TO_STATUS.CREATED,
        created_by: 'verification',
      });
      await this.repo.appendEvent({
        evidence_id: fresh.id,
        tenant_id: claimed.tenant_id,
        event_type: 'CREATED',
        actor: 'verification',
        occurred_at: now,
      });
      if (priorId !== null) await this.supersede(priorId, fresh.id);
    }

    await this.recompute(claimed.subject_id, claimed.tenant_id, now);
    return {
      verified: true,
      subject_id: claimed.subject_id,
      tenant_id: claimed.tenant_id,
    };
  }

  // TR-8 D1 — the current (VALID, non-superseded) platform-verification evidence
  // for a (subject, assertion_type, value), or null. Renewal supersedes it. There
  // is at most one VALID such row (each renewal supersedes the last).
  private async findCurrentVerificationEvidence(
    subjectId: string,
    assertionType: string,
    normalizedValue: string,
  ): Promise<string | null> {
    const rows = await this.repo.listEvidenceBySubject(subjectId, {
      dimension: 'IDENTITY',
      current_status: 'VALID',
    });
    const match = rows.find(
      (e) =>
        e.assertion_type === assertionType &&
        (e.assertion_payload as { normalized_value?: string } | null)?.normalized_value ===
          normalizedValue,
    );
    return match?.id ?? null;
  }

  // TR-2a-B2 (DDR-2 §2 + Amendment §2.1 + Name-Wiring §1) — the arrival-time
  // resolve DECISION. The B1 R1.3 "oldest anchor wins" auto-resolve is RETIRED.
  //
  // Target subjects = each hit anchor's origin subject resolved to its ACTIVE
  // FIXPOINT (never a MERGED husk; cycle/limit → split, logged loudly). Per
  // target, C_st = the strongest source_class among its anchors for (EMAIL,value).
  //   - CONFIRMED: exactly ONE ACTIVE target, isConfirmingAnchor(C_in) AND
  //     isConfirmingAnchor(C_st) AND the NAME guard passes → auto-resolve;
  //     per-arrival observation at C_in; confirmed_anchor_match.
  //   - NAME conflict (Amendment §2.2) → DEMOTE to split; the hand-off advisory
  //     for (new subject, target) carries corroborator_conflict_kinds=['NAME'].
  //   - NEEDS-REVIEW (ambiguity): ≥2 ACTIVE targets, ALL confirming, C_in
  //     confirming → new subject + anchor; hand-off on the new subject AND each
  //     conflicting target (the triangle).
  //   - SPLIT / UNRESOLVED: everything else → new subject (+ anchor at C_in if a
  //     claim is present); new_identity.
  // Product-visible (DDR-2 §2.2): no live channel supplies a confirming C_in, so
  // nothing auto-resolves today — look-alikes accumulate as advisories (test j).
  // The hand-off (matchSubject) runs on EVERY outcome, awaited + loud-fail (§3.3).
  async recordSourcedArrival(
    input: RecordSourcedArrivalInput,
  ): Promise<RecordSourcedArrivalResult> {
    const now = new Date();
    const cIn = input.source_class;
    let subjectId: string;
    let resolution_method: RecordSourcedArrivalResult['resolution_method'] = 'new_identity';
    let contactWritten = 0;
    // Hand-off plan (executed after the recompute).
    let ambiguityTargets: string[] = [];
    let corroboratorConflicts: CorroboratorConflictsByTarget | undefined;

    if (input.verified_email !== null) {
      const anchors = await this.repo.findAnchorsByValue(
        input.tenant_id,
        'EMAIL',
        input.verified_email,
      );

      // Resolve each hit anchor's origin to its ACTIVE fixpoint; group the hit
      // anchors by target so C_st = strongest class among a target's own anchors.
      const targetAnchors = new Map<string, SubjectAnchorRow[]>();
      let anomaly = false;
      for (const anchor of anchors) {
        const fp = await this.repo.resolveActiveFixpoint(anchor.subject_id);
        if (fp.kind === 'ACTIVE') {
          const arr = targetAnchors.get(fp.subjectId) ?? [];
          arr.push(anchor);
          targetAnchors.set(fp.subjectId, arr);
        } else if (fp.kind === 'CYCLE' || fp.kind === 'LIMIT') {
          anomaly = true;
          this.logger.error(
            `recordSourcedArrival fixpoint anomaly (${fp.kind}) origin=${anchor.subject_id} tenant=${input.tenant_id} — routing to split`,
          );
        } else {
          this.logger.warn(
            `recordSourcedArrival fixpoint dead-end origin=${anchor.subject_id} tenant=${input.tenant_id}`,
          );
        }
      }

      const activeTargets = [...targetAnchors.keys()];
      const cInConfirming = isConfirmingAnchor('EMAIL', cIn);
      const confirmingTargets = activeTargets.filter((t) =>
        isConfirmingAnchor('EMAIL', strongestAnchorClass(targetAnchors.get(t)!)),
      );

      const canConfirm = !anomaly && cInConfirming && confirmingTargets.length > 0;

      if (canConfirm && activeTargets.length === 1) {
        // CONFIRMED case — the single ACTIVE target is confirming. Apply the
        // NAME guard before auto-resolving.
        const target = activeTargets[0]!;
        const targetName = await this.readSubjectName(target);
        if (namesFlatlyConflict(input.declared_name, targetName)) {
          // DEMOTE → split (Amendment §2.2). New subject + anchor; the hand-off
          // advisory for (newSubject, target) carries the NAME conflict.
          subjectId = await this.mintSourcedSubject(input);
          contactWritten += await this.mintEmailAnchorIfAbsent(subjectId, input, now);
          corroboratorConflicts = new Map<string, CorroboratorConflictKind[]>([
            [target, ['NAME']],
          ]);
          this.logger.warn(
            `recordSourcedArrival CONFIRMED-arm NAME conflict → demoted to split target=${target} tenant=${input.tenant_id}`,
          );
        } else {
          // CONFIRMED — auto-resolve to the target. Per-arrival observation at C_in
          // (I10 attributability); the anchor already exists on the target.
          subjectId = target;
          resolution_method = 'confirmed_anchor_match';
          await this.attachContactEvidence(subjectId, input, 'EMAIL', input.verified_email, now);
          contactWritten += 1;
        }
      } else if (canConfirm && confirmingTargets.length === activeTargets.length) {
        // NEEDS-REVIEW (ambiguity) — ≥2 ACTIVE targets, all confirming, C_in
        // confirming. NO auto-resolve; new subject + anchor; the triangle.
        subjectId = await this.mintSourcedSubject(input);
        contactWritten += await this.mintEmailAnchorIfAbsent(subjectId, input, now);
        ambiguityTargets = confirmingTargets;
      } else {
        // SPLIT — a hit that is not a clean confirming single target (C_in
        // non-confirming, no confirming target, mixed targets, or an anomaly).
        subjectId = await this.mintSourcedSubject(input);
        contactWritten += await this.mintEmailAnchorIfAbsent(subjectId, input, now);
      }
    } else {
      // UNRESOLVED — no identity claim → a new subject, no anchor.
      subjectId = await this.mintSourcedSubject(input);
    }

    // profile_url — an unverified contact evidence (never an identity anchor).
    if (input.profile_url !== null) {
      await this.attachContactEvidence(subjectId, input, 'PROFILE_URL', input.profile_url, now);
      contactWritten += 1;
    }

    // TR-2b B1 PR-2 (DDR R4) — REVERSE LINKAGE. When the arrival was admitted to
    // a PERSON_CLUSTER (cluster_id non-null, set by the canonicalization mint
    // AFTER the admission-policy gate), attach a PERSON_CLUSTER ResolutionSubjectRef
    // to the resolved subject — the queryable, tenant-carrying pointer INTO
    // identity_index. Reuses the standing idempotent ref-writer (attachSubjectRef
    // → repo.attachRef dedupes on the [tenant_id, ref_type, ref_id] unique), so a
    // second arrival resolving to the same cluster is a no-op, not an error. No
    // ref without a mint (the guard is the admission gate, upstream). CONSISTENCY
    // POSTURE (recorded for Gate-6): recordSourcedArrival has no outer tx — the
    // subject + SOURCED_TALENT ref + this PERSON_CLUSTER ref are separate
    // idempotent repo writes on talent-trust's own client, matching the existing
    // cross-connection posture of the resolved_cluster_id stamp (no shared tx
    // exists across these schemas today; a re-run re-resolves idempotently).
    if (input.cluster_id !== null) {
      await this.attachSubjectRef({
        tenant_id: input.tenant_id,
        subject_id: subjectId,
        ref_type: 'PERSON_CLUSTER',
        ref_id: input.cluster_id,
        link_source: input.created_by,
      });
    }

    await this.recompute(subjectId, input.tenant_id, now);

    // Resolver→matcher hand-off on EVERY outcome (DDR-2 §3), AWAITED after the
    // recompute, LOUD-FAIL (errors propagate — an advisory silently not raised is
    // a silent split with no warn). Ambiguity adds each conflicting target.
    await this.matcher.matchSubject(input.tenant_id, subjectId, corroboratorConflicts);
    for (const target of ambiguityTargets) {
      await this.matcher.matchSubject(input.tenant_id, target);
    }

    return { subject_id: subjectId, resolution_method, contact_evidence_written: contactWritten };
  }

  // Mint (or resolve idempotently) the SOURCED_TALENT subject for this arrival.
  private async mintSourcedSubject(input: RecordSourcedArrivalInput): Promise<string> {
    return this.repo.resolveOrCreateSubject(
      input.tenant_id,
      'SOURCED_TALENT',
      input.payload_id,
      input.created_by,
    );
  }

  // Record the arrival's email SubjectAnchor at C_in (evidence + projection in one
  // tx), exists-checked at (tenant, subject, EMAIL, value, class) for re-run
  // safety. Returns 1 if minted, 0 if already present. Only called when a claim
  // is present (input.verified_email non-null in the caller's branch).
  private async mintEmailAnchorIfAbsent(
    subjectId: string,
    input: RecordSourcedArrivalInput,
    now: Date,
  ): Promise<number> {
    const email = input.verified_email!;
    const existing = await this.repo.findSubjectAnchor(
      input.tenant_id,
      subjectId,
      'EMAIL',
      email,
      input.source_class,
    );
    if (existing !== null) return 0;
    const strength = deriveStrength(input.source_class, 'DOCUMENT');
    await this.repo.insertAnchor({
      evidence: {
        subject_id: subjectId,
        tenant_id: input.tenant_id,
        dimension: 'IDENTITY',
        assertion_type: 'EMAIL',
        // TR-4 B1 (DDR §2.3) — canonical contact key `value` (normalized email);
        // converged forward from the legacy `normalized_value` key.
        assertion_payload: {
          value: email,
          source_channel: input.source_channel,
          payload_id: input.payload_id,
        },
        source_class: input.source_class,
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
      normalized_value: email,
    });
    return 1;
  }

  // The target subject's known name, reconstructed from its FULL_NAME evidence
  // (first_name + last_name; cold-ingest extraction is its writer). Multiple
  // FULL_NAME rows combine into one token pool — the NAME guard tokenizes it.
  // Null when the subject has no name evidence (absence never conflicts).
  private async readSubjectName(subjectId: string): Promise<string | null> {
    const evidence = await this.repo.listEvidenceBySubject(subjectId);
    const parts: string[] = [];
    for (const e of evidence) {
      if (e.assertion_type !== 'FULL_NAME') continue;
      const p = e.assertion_payload as { first_name?: unknown; last_name?: unknown };
      if (typeof p.first_name === 'string' && p.first_name.length > 0) parts.push(p.first_name);
      if (typeof p.last_name === 'string' && p.last_name.length > 0) parts.push(p.last_name);
    }
    return parts.length > 0 ? parts.join(' ') : null;
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
    // Per-arrival observation evidence carries the ARRIVAL's attestation level
    // (DDR-1 §3.1 threaded value), replacing the old hard-coded literal. strength
    // derives from the same class so the row stays coherent.
    const strength = deriveStrength(input.source_class, 'DOCUMENT');
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
      source_class: input.source_class,
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
      // TR-4 B1 (DDR §2.2) — same canonical-shape gate as recordEvidence: a
      // registered type refuses a non-conforming payload; unregistered passes through.
      const canonicalPayload = this.canonicalizeOrRefuse(e.assertion_type, e.assertion_payload);
      const evidence = await this.repo.insertEvidence({
        subject_id: input.subject_id,
        tenant_id: input.tenant_id,
        dimension: e.dimension,
        assertion_type: e.assertion_type,
        assertion_payload: canonicalPayload,
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

  // TR-4 B2 (DDR §3.1/§3.2) — the idempotent CLAIMS dual-write behind the
  // talent-extraction producer. Resolves (or creates) the subject from the ref,
  // then writes canonical CLAIMS evidence ONLY IF no evidence already exists for
  // this (subject, assertion_type, source_ref → the typed row). The source_ref is
  // the STABLE typed-row id, so a re-run / backfill re-writes nothing already
  // written (§3.2). The write goes through recordEvidence — the T4-B1 canonical
  // gate validates the payload (the mapper guarantees conformance, so it never
  // fires here) and the recompute fires (CLAIMS moves off NOT_ESTABLISHED). A
  // write failure PROPAGATES (loud fail per §3.3 — never a silent half-commit).
  async recordDeclaredClaimIfAbsent(input: {
    subjectRef: SubjectRef;
    assertion_type: string;
    assertion_payload: unknown;
    // Must carry `talent_evidence_id` (the typed-row provenance key).
    source_ref: { talent_evidence_id: string } & Record<string, unknown>;
    created_by: string;
  }): Promise<{ written: boolean; evidence_id?: string }> {
    const subjectId = await this.repo.resolveOrCreateSubject(
      input.subjectRef.tenant_id,
      input.subjectRef.ref_type,
      input.subjectRef.ref_id,
      input.subjectRef.link_source ?? input.created_by,
    );
    const exists = await this.repo.claimEvidenceExistsBySourceRef(
      subjectId,
      input.assertion_type,
      input.source_ref.talent_evidence_id,
    );
    if (exists) return { written: false };

    const ev = await this.recordEvidence({
      subjectRef: input.subjectRef,
      dimension: 'CLAIMS',
      assertion_type: input.assertion_type,
      assertion_payload: input.assertion_payload,
      // DDR §3: channel-structured, LLM-shaped declared claims.
      source_class: 'THIRD_PARTY_UNVERIFIED',
      method: 'DOCUMENT',
      source_ref: input.source_ref,
      // Ruling 5 — the STRUCTURING is LLM; ai_derived says who shaped it (zero band
      // influence by construction). class/method say how it arrived.
      ai_derived: true,
      portability_class: 'TENANT_ONLY',
      decay_profile: 'SLOW',
      created_by: input.created_by,
    });
    return { written: true, evidence_id: ev.id };
  }

  // TR-9 B1 (D5) — the reference-attestation capture, idempotent. A recruiter
  // records a reference they already lawfully hold; the platform contacts no one.
  // Fixed by D2: source_class THIRD_PARTY_UNVERIFIED (the honest floor — the
  // attester is unverified) × method HUMAN_ATTESTED (the reserved hook's FIRST
  // producer). The write gate canonicalizes here first so the descriptor + the
  // content-hash are derived from the SAME canonical the ledger stores: the
  // descriptor keys D3 independence-collapse (source_ref.attester_key), the
  // content-hash keys idempotence (the same reference twice is one row). Recompute
  // rides recordEvidence; the D4 overlap detector fires on the next consistency pass.
  async recordReferenceAttestationIfAbsent(input: {
    subjectRef: SubjectRef;
    dimension: TrustDimension;
    assertion_payload: Record<string, unknown>;
    requestId?: string;
  }): Promise<{ written: boolean; evidence_id: string }> {
    const shape = validateClaimShape('ATTESTATION', input.assertion_payload);
    if (!shape.ok || shape.canonical === undefined) {
      throw new AramoError(
        'CLAIM_SHAPE_INVALID',
        `ATTESTATION payload invalid: ${(shape.errors ?? []).join('; ')}`,
        422,
        { requestId: input.requestId ?? CLAIM_SHAPE_REQUEST_ID },
      );
    }
    const canonical = shape.canonical;
    const attester = (canonical['attester'] ?? {}) as Record<string, unknown>;
    const attester_key = attesterDescriptorKey(attester);
    const content_hash = hashCanonicalizedBody(canonical);

    const subjectId = await this.repo.resolveOrCreateSubject(
      input.subjectRef.tenant_id,
      input.subjectRef.ref_type,
      input.subjectRef.ref_id,
      input.subjectRef.link_source ?? 'reference-capture',
    );
    const existing = await this.repo.findAttestationByContentHash(subjectId, content_hash);
    if (existing !== null) return { written: false, evidence_id: existing };

    const ev = await this.recordEvidence({
      subjectRef: input.subjectRef,
      dimension: input.dimension,
      assertion_type: 'ATTESTATION',
      assertion_payload: input.assertion_payload,
      source_class: 'THIRD_PARTY_UNVERIFIED',
      method: 'HUMAN_ATTESTED',
      source_ref: { content_hash, attester_key },
      ai_derived: false,
      portability_class: 'TENANT_ONLY',
      decay_profile: 'MODERATE',
      created_by: 'reference-capture',
    });
    return { written: true, evidence_id: ev.id };
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
    // TR-4 B1 (DDR §2.4) — a repeat raise of the SAME contradiction is a NO-OP,
    // not an error (and not a duplicate row): the semantic fact already stands.
    // The link @@unique backs this at the DB; this check keeps it a clean no-op
    // and avoids a spurious re-CONTRADICTED event on an already-contradicted record.
    if (await this.repo.evidenceLinkExists(byEvidenceId, evidenceId, 'CONTRADICTS')) {
      return;
    }
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

  // TR-4 B3 (§3.2.1, the §2.2 finding) — LINKLESS single-record contradiction. The
  // contradict() arm above requires a contradicting counterpart (byEvidenceId); an
  // arithmetic impossibility (end < start) has no counterpart evidence. This flips
  // the record to CONTRADICTED with a reason and NO EvidenceLink. Guard: an
  // already-CONTRADICTED record is a no-op (re-runs are idempotent). Only the status
  // drives the band cap (band derivation never reads links), so the linkless variant
  // caps the dimension exactly as the paired one does.
  async contradictRecord(evidenceId: string, reason: string): Promise<void> {
    const ev = await this.requireEvidence(evidenceId);
    if (ev.current_status === 'CONTRADICTED') return;
    await this.applyLifecycle(evidenceId, 'CONTRADICTED', { reason, evidence: ev });
  }

  async supersede(oldId: string, newId: string): Promise<void> {
    const ev = await this.requireEvidence(oldId);
    // TR-4 B1 (DDR §2.4) — repeat supersession of the same pair is a no-op.
    if (await this.repo.evidenceLinkExists(newId, oldId, 'SUPERSEDES')) {
      return;
    }
    await this.repo.appendLink({
      from_evidence_id: newId,
      to_evidence_id: oldId,
      relation: 'SUPERSEDES',
      tenant_id: ev.tenant_id,
    });
    await this.applyLifecycle(oldId, 'SUPERSEDED', { linked_evidence_id: newId, evidence: ev });
  }

  // TR-15 B1 (DDR §2) — dispute completed to the resolveContradiction standard.
  // v1 disputes are recruiter/admin-raised on a talent's communicated objection
  // (the talent-raised surface is TR-15-B). Status-guarded: only a VALID record
  // disputes; a repeat (already DISPUTED) is a no-op returning current state
  // (idempotent re-raise); any other status refuses with a domain code. Full
  // actor + grounds audit event. requestId threads into the refusal envelope
  // (defaults to the lib sentinel off-HTTP).
  async dispute(
    evidenceId: string,
    actor: string,
    grounds: string,
    requestId: string = CLAIM_SHAPE_REQUEST_ID,
  ): Promise<{ status: EvidenceStatus }> {
    const ev = await this.requireEvidence(evidenceId);
    if (ev.current_status === 'DISPUTED') {
      // Repeat raise on an already-open dispute → no-op returning current state.
      return { status: ev.current_status };
    }
    if (ev.current_status !== 'VALID') {
      // Only a live (VALID) record can be disputed — a dispute against a STALE/
      // CONTRADICTED/REVOKED/SUPERSEDED row is meaningless. Domain-coded 422.
      throw new AramoError(
        'EVIDENCE_NOT_DISPUTABLE',
        `dispute requires a VALID record (evidence ${evidenceId} is ${ev.current_status})`,
        422,
        { requestId, details: { evidence_id: evidenceId, current_status: ev.current_status } },
      );
    }
    await this.applyLifecycle(evidenceId, 'DISPUTED', {
      reason: grounds,
      actor,
      evidence: ev,
    });
    return { status: 'DISPUTED' };
  }

  // TR-15 B1 (DDR §2) — resolveDispute with outcomes made real inside the
  // existing closed vocab. Guarded: only a DISPUTED record resolves. rejected →
  // DISPUTE_RESOLVED → VALID (the existing path, now with actor + justification);
  // upheld → DISPUTE_RESOLVED atomically chained with REVOKED (two events, ONE
  // tx — the honest trail: the dispute resolved, and the evidence retired because
  // it was wrong). Recompute rides both. The DTO is lenient (IsString), so the
  // outcome is validated HERE → DISPUTE_OUTCOME_INVALID for anything else.
  async resolveDispute(
    evidenceId: string,
    actor: string,
    outcome: string,
    justification: string,
    requestId: string = CLAIM_SHAPE_REQUEST_ID,
  ): Promise<{ status: EvidenceStatus }> {
    const ev = await this.requireEvidence(evidenceId);
    if (ev.current_status !== 'DISPUTED') {
      // A resolve is meaningful only against a standing dispute (mirrors the
      // contradiction template's not-CONTRADICTED refusal). Domain-coded 422.
      throw new AramoError(
        'EVIDENCE_NOT_DISPUTED',
        `resolveDispute requires a DISPUTED record (evidence ${evidenceId} is ${ev.current_status})`,
        422,
        { requestId, details: { evidence_id: evidenceId, current_status: ev.current_status } },
      );
    }
    if (outcome !== 'upheld' && outcome !== 'rejected') {
      throw new AramoError(
        'DISPUTE_OUTCOME_INVALID',
        `resolveDispute outcome must be 'upheld' or 'rejected' (got ${JSON.stringify(outcome)})`,
        422,
        { requestId, details: { evidence_id: evidenceId, outcome } },
      );
    }
    if (outcome === 'rejected') {
      // The dispute did not hold → the record returns to VALID and re-accrues.
      await this.applyLifecycle(evidenceId, 'DISPUTE_RESOLVED', {
        reason: justification,
        actor,
        evidence: ev,
      });
      return { status: 'VALID' };
    }
    // upheld → the evidence was wrong: resolve the dispute AND retire the
    // evidence, atomically (DISPUTE_RESOLVED then REVOKED in one transaction —
    // a mid-tx failure leaves neither event and no status change). REVOKED is
    // excluded from accrual, so the retirement is permanent for this row.
    await this.repo.appendResolvedThenRevoked({
      evidence_id: evidenceId,
      tenant_id: ev.tenant_id,
      actor,
      justification,
    });
    await this.recompute(ev.subject_id, ev.tenant_id, new Date());
    return { status: 'REVOKED' };
  }

  // TR-4 B1 (DDR §2.4) — the CLOSURE ARM the contradiction machinery has lacked
  // since TR-1. Human-invoked (B3 adds the API; no controller this slice): a
  // CONTRADICTED record is resolved back to VALID with an actor + reason, and the
  // recompute lifts the dimension's CORROBORATED cap. GUARDED — only a currently
  // CONTRADICTED record resolves; anything else refuses (a resolve is meaningful
  // only against a standing contradiction). Distinct from resolveDispute (the
  // DISPUTED axis). Does NOT touch the CONTRADICTS link (append-only history stays).
  async resolveContradiction(
    evidenceId: string,
    actor: string,
    reason: string,
    requestId: string = CLAIM_SHAPE_REQUEST_ID,
  ): Promise<void> {
    const ev = await this.requireEvidence(evidenceId);
    if (ev.current_status !== 'CONTRADICTED') {
      // TR-4 B3 (§3.3) — the resolve API's not-CONTRADICTED refusal. A resolve is
      // meaningful only against a standing contradiction. Domain-coded 422; the
      // controller passes its requestId (defaults to the lib sentinel off-HTTP).
      throw new AramoError(
        'EVIDENCE_NOT_CONTRADICTED',
        `resolveContradiction requires a CONTRADICTED record (evidence ${evidenceId} is ${ev.current_status})`,
        422,
        { requestId, details: { evidence_id: evidenceId, current_status: ev.current_status } },
      );
    }
    await this.applyLifecycle(evidenceId, 'CONTRADICTION_RESOLVED', {
      reason,
      actor,
      evidence: ev,
    });
  }

  // TR-4 B3 (§3.2.3) — record an interior TIMELINE_GAP as CONTINUITY evidence,
  // idempotent on the (before, after) composite source_ref. THIRD_PARTY_UNVERIFIED
  // (the inference cannot outrank its third-party inputs) × DERIVED (arithmetic, not
  // a source pull) → strength 0.15; ai_derived:false (deterministic, not an LLM).
  // Goes through the canonical gate (the payload always conforms) + recompute rides
  // the caller's run.
  async recordTimelineGapIfAbsent(input: {
    tenant_id: string;
    subject_id: string;
    gap_start: string;
    gap_end: string;
    before_evidence_id: string;
    after_evidence_id: string;
  }): Promise<{ written: boolean; evidence_id?: string }> {
    const exists = await this.repo.timelineGapExists(
      input.subject_id,
      input.before_evidence_id,
      input.after_evidence_id,
    );
    if (exists) return { written: false };

    const canonical = this.canonicalizeOrRefuse('TIMELINE_GAP', {
      gap_start: input.gap_start,
      gap_end: input.gap_end,
      before_evidence_id: input.before_evidence_id,
      after_evidence_id: input.after_evidence_id,
    });
    const now = new Date();
    const evidence = await this.repo.insertEvidence({
      subject_id: input.subject_id,
      tenant_id: input.tenant_id,
      dimension: 'CONTINUITY',
      assertion_type: 'TIMELINE_GAP',
      assertion_payload: canonical,
      source_class: 'THIRD_PARTY_UNVERIFIED',
      method: 'DERIVED',
      strength: deriveStrength('THIRD_PARTY_UNVERIFIED', 'DERIVED'),
      source_ref: {
        before_evidence_id: input.before_evidence_id,
        after_evidence_id: input.after_evidence_id,
        kind: 'timeline_gap',
      },
      collected_at: now,
      decay_profile: 'SLOW',
      portability_class: 'TENANT_ONLY',
      ai_derived: false,
      current_status: EVENT_TO_STATUS.CREATED,
      created_by: 'consistency',
    });
    await this.repo.appendEvent({
      evidence_id: evidence.id,
      tenant_id: input.tenant_id,
      event_type: 'CREATED',
      actor: 'consistency',
      occurred_at: now,
    });
    return { written: true, evidence_id: evidence.id };
  }

  // TR-4 B3 (§3.1/§3.2) — run the three deterministic detectors over a subject's
  // CLUSTER-UNION CLAIMS evidence, execute the plan through the lifecycle arms +
  // recordEvidence, and recompute. Silence over speculation is the pure detectors'
  // (consistency-detectors.ts) job; this method only executes. Bands move ONLY
  // through the final recompute. Idempotent (link unique + no-op + gap
  // existence-check + already-CONTRADICTED guard), so the poll re-runs safely.
  async runConsistencyForSubject(
    tenantId: string,
    subjectId: string,
  ): Promise<{ contradictions: number; gaps_opened: number; gaps_healed: number }> {
    const members = await this.repo.clusterMembers(subjectId);
    const claimsEvidence = await this.repo.listEvidenceBySubjects(members, { dimension: 'CLAIMS' });
    const continuityEvidence = await this.repo.listEvidenceBySubjects(members, {
      dimension: 'CONTINUITY',
    });
    // TR-5 B2 — the CONTINUITY derivers read IDENTITY contact evidence too (the
    // per-arrival observations that prove longitudinal presence).
    const identityEvidence = await this.repo.listEvidenceBySubjects(members, {
      dimension: 'IDENTITY',
    });

    const claims: EmploymentClaim[] = claimsEvidence
      .filter((e) => e.assertion_type === 'EMPLOYMENT')
      .map((e) => {
        const p = (e.assertion_payload ?? {}) as Record<string, unknown>;
        return {
          evidence_id: e.id,
          source_class: e.source_class,
          source_ref: e.source_ref,
          employer_norm: typeof p['employer_norm'] === 'string' ? p['employer_norm'] : null,
          start_date: typeof p['start_date'] === 'string' ? p['start_date'] : null,
          end_date: typeof p['end_date'] === 'string' ? p['end_date'] : null,
          collected_at: e.collected_at,
          current_status: e.current_status,
        };
      });
    const existingGaps: ExistingGap[] = continuityEvidence
      .filter((e) => e.assertion_type === 'TIMELINE_GAP')
      .map((e) => {
        const p = (e.assertion_payload ?? {}) as Record<string, unknown>;
        return {
          evidence_id: e.id,
          before_evidence_id: String(p['before_evidence_id'] ?? ''),
          after_evidence_id: String(p['after_evidence_id'] ?? ''),
          gap_start: String(p['gap_start'] ?? ''),
          gap_end: String(p['gap_end'] ?? ''),
          current_status: e.current_status,
        };
      });

    const plan = computeConsistencyPlan(claims, existingGaps);

    for (const id of plan.impossibleRangeIds) {
      await this.contradictRecord(id, REASON_IMPOSSIBLE_RANGE);
    }
    for (const c of plan.employerConflicts) {
      await this.contradict(c.a_id, c.b_id, REASON_EMPLOYER_CONFLICT_SAME_WINDOW);
    }

    // TR-9 B1 (D4) — the ring's cheapest tell, in the same pass. Reduce the
    // cluster's ATTESTATION evidence to (id, attester email); for each distinct
    // email, ask the matcher's shared-value lookup whether it is a subject anchor
    // value in the tenant (a "referee" who is a talent's own identity). The
    // pure detector flips the overlaps; absent-email attestations stay silent.
    const attestations: AttestationClaim[] = claimsEvidence
      .filter((e) => e.assertion_type === 'ATTESTATION')
      .map((e) => {
        const p = (e.assertion_payload ?? {}) as Record<string, unknown>;
        const attester = (p['attester'] ?? {}) as Record<string, unknown>;
        const email = attester['email_norm'];
        return {
          evidence_id: e.id,
          attester_email_norm: typeof email === 'string' && email.length > 0 ? email : null,
          current_status: e.current_status,
        };
      });
    const overlappingEmails = new Set<string>();
    for (const email of new Set(
      attestations.map((a) => a.attester_email_norm).filter((e): e is string => e !== null),
    )) {
      const anchors = await this.repo.findAnchorsByValue(tenantId, 'EMAIL', email);
      if (anchors.length > 0) overlappingEmails.add(email);
    }
    const attesterOverlapIds = detectAttesterIdentityOverlap(attestations, overlappingEmails);
    for (const id of attesterOverlapIds) {
      await this.contradictRecord(id, REASON_ATTESTER_IDENTITY_OVERLAP);
    }
    let gaps_opened = 0;
    for (const g of plan.gapsToOpen) {
      const r = await this.recordTimelineGapIfAbsent({
        tenant_id: tenantId,
        subject_id: subjectId,
        gap_start: g.gap_start,
        gap_end: g.gap_end,
        before_evidence_id: g.before_evidence_id,
        after_evidence_id: g.after_evidence_id,
      });
      if (r.written) gaps_opened += 1;
    }
    for (const h of plan.gapsToHeal) {
      await this.supersede(h.gap_evidence_id, h.filler_evidence_id);
    }

    // TR-5 B2 (DDR §3) — the two positive CONTINUITY derivers, beside the
    // detectors in the same pass. LONGITUDINAL_PRESENCE reads the IDENTITY contact
    // observations; HISTORY_SPAN reads the same EMPLOYMENT claims + the open-gap
    // state. The pure deriver returns write/replace/retire/no-op per assertion
    // type; this executes it. The final recompute prices whatever landed. The
    // CONTINUITY evidence is RE-READ inside (not the pre-detector snapshot), so a
    // gap opened/healed THIS pass is seen — a fresh gap retires a span at once.
    await this.runContinuityDerivers({ tenantId, subjectId, members, identityEvidence, claims });

    await this.recompute(subjectId, tenantId, new Date());
    return {
      contradictions:
        plan.impossibleRangeIds.length +
        plan.employerConflicts.length +
        attesterOverlapIds.length,
      gaps_opened,
      gaps_healed: plan.gapsToHeal.length,
    };
  }

  // TR-5 B2 (DDR §3) — execute the CONTINUITY derivation plan. PURE decision in
  // continuity-derivers.ts; this method is the I/O arm. One VALID derived row per
  // (subject, assertion_type): write a first, replace on basis change (supersede
  // the prior), retire without replacement when the basis breaks (a newly-opened
  // gap supersedes a HISTORY_SPAN), or no-op when the current row still holds.
  private async runContinuityDerivers(input: {
    tenantId: string;
    subjectId: string;
    members: string[];
    identityEvidence: EvidenceRecordRow[];
    claims: EmploymentClaim[];
  }): Promise<void> {
    // RE-READ CONTINUITY (not the pre-detector snapshot) so a gap opened/healed
    // earlier in THIS pass is reflected — the span retires the same tick a gap opens.
    const continuityEvidence = await this.repo.listEvidenceBySubjects(input.members, {
      dimension: 'CONTINUITY',
    });

    const contactObservations: ContactObservation[] = input.identityEvidence
      .filter((e) => (CONTACT_ANCHOR_KINDS as readonly string[]).includes(e.assertion_type))
      .map((e) => {
        const p = (e.assertion_payload ?? {}) as Record<string, unknown>;
        return {
          evidence_id: e.id,
          anchor_kind: e.assertion_type,
          value: typeof p['value'] === 'string' ? p['value'] : '',
          source_class: e.source_class,
          collected_at: e.collected_at,
          current_status: e.current_status,
        };
      });

    const employmentClaims = input.claims.map((c) => ({
      evidence_id: c.evidence_id,
      source_class: c.source_class,
      start_date: c.start_date,
      end_date: c.end_date,
      current_status: c.current_status,
    }));
    const openGaps = continuityEvidence
      .filter((e) => e.assertion_type === 'TIMELINE_GAP')
      .map((e) => ({ current_status: e.current_status }));

    // The current VALID derived row per type (the supersede-replace invariant keeps
    // it singular; if more than one is VALID, take the lowest id deterministically).
    const currentDerived = (assertionType: string): ExistingDerived | null => {
      const rows = continuityEvidence
        .filter((e) => e.assertion_type === assertionType && e.current_status === 'VALID')
        .sort((a, b) => (a.id < b.id ? -1 : 1));
      const row = rows[0];
      return row ? { evidence_id: row.id, payload: (row.assertion_payload ?? {}) as Record<string, unknown> } : null;
    };

    const plan = computeContinuityDerivations({
      contactObservations,
      employmentClaims,
      openGaps,
      existingLongitudinal: currentDerived(LONGITUDINAL_PRESENCE),
      existingHistorySpan: currentDerived(HISTORY_SPAN),
    });

    await this.executeDerivedAction(input.tenantId, input.subjectId, LONGITUDINAL_PRESENCE, plan.longitudinal);
    await this.executeDerivedAction(input.tenantId, input.subjectId, HISTORY_SPAN, plan.historySpan);
  }

  private async executeDerivedAction(
    tenantId: string,
    subjectId: string,
    assertionType: string,
    action: DerivedAction<LongitudinalPresencePayload> | DerivedAction<HistorySpanPayload>,
  ): Promise<void> {
    if (action.kind === 'noop') return;
    if (action.kind === 'retire') {
      // Supersession WITHOUT replacement — the basis broke (e.g. a new gap opened
      // under a HISTORY_SPAN). SUPERSEDED clears the flag; no from-link exists.
      await this.applyLifecycle(action.supersede_id, 'SUPERSEDED', {});
      return;
    }
    const newId = await this.writeDerivedContinuity(tenantId, subjectId, assertionType, action.payload, action.source_class);
    if (action.kind === 'replace') {
      await this.supersede(action.supersede_id, newId);
    }
  }

  // The derived-CONTINUITY writer — mirrors recordTimelineGapIfAbsent. DERIVED
  // method (an inference, not a source pull) × the FLOOR class of its inputs
  // (§3.1 — the inference cannot outrank them). ai_derived:false (deterministic,
  // not an LLM). Goes through the canonical gate (the payload always conforms).
  private async writeDerivedContinuity(
    tenantId: string,
    subjectId: string,
    assertionType: string,
    payload: object,
    sourceClass: SourceClass,
  ): Promise<string> {
    const canonical = this.canonicalizeOrRefuse(assertionType, payload);
    const now = new Date();
    const evidence = await this.repo.insertEvidence({
      subject_id: subjectId,
      tenant_id: tenantId,
      dimension: 'CONTINUITY',
      assertion_type: assertionType,
      assertion_payload: canonical,
      source_class: sourceClass,
      method: 'DERIVED',
      strength: deriveStrength(sourceClass, 'DERIVED'),
      source_ref: { kind: assertionType.toLowerCase() },
      collected_at: now,
      decay_profile: 'SLOW',
      portability_class: 'TENANT_ONLY',
      ai_derived: false,
      current_status: EVENT_TO_STATUS.CREATED,
      created_by: 'consistency',
    });
    await this.repo.appendEvent({
      evidence_id: evidence.id,
      tenant_id: tenantId,
      event_type: 'CREATED',
      actor: 'consistency',
      occurred_at: now,
    });
    return evidence.id;
  }

  // ---- Subject capability (§8) — reversible; logic deferred to TR-6 ---

  async mergeSubjects(
    survivingSubjectId: string,
    mergedSubjectId: string,
    reason: string,
    actor: string,
  ): Promise<ResolutionSubjectRow> {
    const surviving = await this.requireSubject(survivingSubjectId);
    await this.requireSubject(mergedSubjectId);
    // TR-6 B1 (DDR §5) — the TR-1 merge-audit debt closes here: the merge persists
    // to SubjectMergeOperation (the void reason dies). A minimal PENDING DIRECT_MERGE
    // row carrying actor + reason + the subject pair (record fields null). If a
    // record-reconcile follows (the approve→reconcile path), the orchestrator finds
    // THIS row via findMergeOperationBySubjects and ENRICHES it — no second row.
    const prior = await this.repo.findMergeOperationBySubjects(
      surviving.tenant_id,
      survivingSubjectId,
      mergedSubjectId,
    );
    if (prior === null) {
      await this.repo.createMergeOperation({
        tenant_id: surviving.tenant_id,
        kind: 'DIRECT_MERGE',
        actor,
        reason,
        advisory_id: null,
        surviving_subject_id: survivingSubjectId,
        merged_subject_id: mergedSubjectId,
        surviving_record_id: null,
        superseded_record_id: null,
      });
    }
    return this.repo.setSubjectMergeState(mergedSubjectId, 'MERGED', survivingSubjectId);
  }

  async unmergeSubjects(
    mergedSubjectId: string,
    reason: string,
    actor: string,
  ): Promise<ResolutionSubjectRow> {
    const subject = await this.requireSubject(mergedSubjectId);
    // TR-6 B1 (DDR §5) — the void reason dies. An operation-backed merge (a prior
    // SubjectMergeOperation for this direction) records its reversal on THAT row via
    // the existing reconcile-reverse path (as today) — do NOT touch it here, or the
    // orchestrator's COMPLETED-gate for the heavy topology restore would be skipped.
    // A direct unmerge with NO prior row writes its own minimal terminal DIRECT_UNMERGE
    // audit row (actor + reason + pair; record fields null).
    const survivingSubjectId = subject.merged_into_subject_id;
    const prior =
      survivingSubjectId === null
        ? null
        : await this.repo.findMergeOperationBySubjects(
            subject.tenant_id,
            survivingSubjectId,
            mergedSubjectId,
          );
    if (prior === null) {
      // Terminal REVERSED (not COMPLETED): this minimal row IS the reversal record,
      // and the advisory-resolution controller reverses a merge ONLY when
      // findMergeOperationBySubjects returns a COMPLETED op — a DIRECT_UNMERGE must
      // never be mistaken for a reversible merge topology (there is none). REVERSED
      // also keeps D6's stale-PENDING detector from flagging it.
      const now = new Date();
      await this.repo.createMergeOperation({
        tenant_id: subject.tenant_id,
        kind: 'DIRECT_UNMERGE',
        actor,
        reason,
        advisory_id: null,
        surviving_subject_id: survivingSubjectId ?? mergedSubjectId,
        merged_subject_id: mergedSubjectId,
        surviving_record_id: null,
        superseded_record_id: null,
        status: 'REVERSED',
        completed_at: now,
      });
    }
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
      single_source_only: false,
      longitudinal_observed: false,
      verified_control_stale: false,
      last_recomputed_at: subject.created_at,
    };
  }

  // TR-2a-B3a (DDR-3 §5) — CLUSTER-UNION evidence read. The ref resolves to its
  // ACTIVE fixpoint (the survivor); getEvidence then surfaces the UNION of every
  // cluster member's evidence, each row carrying its ORIGIN subject_id +
  // provenance UNTOUCHED. Evidence written to a merged husk is NOT stranded — it
  // surfaces here on the survivor. An unmerged subject's cluster is itself, so
  // this is byte-identical to the pre-B3a read for the common case.
  async getEvidence(
    subjectRef: SubjectRef,
    filters?: Parameters<TalentTrustRepository['listEvidenceBySubjects']>[1],
  ): Promise<EvidenceRecordRow[]> {
    const subject = await this.resolveSubjectForRead(subjectRef);
    if (subject === null) return [];
    const members = await this.repo.clusterMembers(subject.id);
    return this.repo.listEvidenceBySubjects(members, filters);
  }

  // TR-14 B1 (DDR §2.2) — the dossier's three "why" reads. Each resolves the ref
  // to its ACTIVE fixpoint (record → survivor, husk-safe) and reads over the
  // CLUSTER-UNION, so a merged identity tells one story. A ref with no subject
  // (the honest add-talent edge) returns empty — never an error.

  // The link graph around a record's evidence: contradiction pairs, supersede
  // chains. Cluster-union-safe (link ids drawn from the union's evidence set).
  async getEvidenceLinks(subjectRef: SubjectRef): Promise<EvidenceLinkRow[]> {
    const subject = await this.resolveSubjectForRead(subjectRef);
    if (subject === null) return [];
    const members = await this.repo.clusterMembers(subject.id);
    const evidence = await this.repo.listEvidenceBySubjects(members);
    return this.repo.listEvidenceLinksForEvidence(evidence.map((e) => e.id));
  }

  // The lifecycle timeline across the cluster-union, keyset newest-first.
  async getEvidenceTimeline(
    subjectRef: SubjectRef,
    opts: { limit: number; before?: { occurred_at: Date; id: string } },
  ): Promise<EvidenceEventRow[]> {
    const subject = await this.resolveSubjectForRead(subjectRef);
    if (subject === null) return [];
    const members = await this.repo.clusterMembers(subject.id);
    return this.repo.listEvidenceEventsBySubjects(members, opts);
  }

  // The provenance line: the COMPLETED merges this identity took part in (either role).
  async getMergeHistory(subjectRef: SubjectRef): Promise<SubjectMergeOperationRow[]> {
    const subject = await this.resolveSubjectForRead(subjectRef);
    if (subject === null) return [];
    return this.repo.listCompletedMergeOperationsForSubject(subjectRef.tenant_id, subject.id);
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

  // Portal P1 PR-2 (OPEN-4) — the cross-tenant holders of a PERSON_CLUSTER id:
  // every {tenant_id, subject_id} whose ResolutionSubjectRef points at the given
  // cluster (the same human across firms). The portal chain's first hop after
  // PortalUser.cluster_id. Platform-rail index-ref graph only — no PII, no
  // cross-tenant tenant-rail read.
  async findClusterHolders(
    clusterId: string,
  ): Promise<{ tenant_id: string; subject_id: string }[]> {
    return this.repo.findSubjectRefsByRef('PERSON_CLUSTER', clusterId);
  }

  // TR-2a-B3a (DDR-3 §2.3/§5) — INTENTIONAL NON-FOLLOWER (origin-keyed by
  // design): refs are keyed to the subject that owns them, not to a merge
  // fixpoint. Do NOT switch this to resolveActiveFixpoint — the promotion no-op
  // and origin-arrival lookup need the ORIGIN subject's own refs.
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

  // TR-4 B1 (DDR §2.2) — validate + normalize a payload against the canonical
  // registry. A REGISTERED assertion_type with a non-conforming payload refuses
  // with CLAIM_SHAPE_INVALID (422); an UNregistered type returns its payload
  // untouched (admission-open passthrough). The returned canonical payload is
  // what gets persisted (normalized fields added, raw preserved, dates ISO-or-null).
  private canonicalizeOrRefuse(
    assertionType: string,
    payload: unknown,
  ): Record<string, unknown> {
    const result = validateClaimShape(assertionType, payload);
    if (!result.ok) {
      throw new AramoError(
        'CLAIM_SHAPE_INVALID',
        `assertion_type '${assertionType}' payload is not canonical: ${(result.errors ?? []).join('; ')}`,
        422,
        {
          requestId: CLAIM_SHAPE_REQUEST_ID,
          details: { assertion_type: assertionType, errors: result.errors ?? [] },
        },
      );
    }
    return result.canonical ?? {};
  }

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

  // TR-2a-B3a (DDR-3 §5) — public cluster-union recompute entry point. The
  // reconcile (B3b) calls this on the survivor at phase-2 end, and on BOTH
  // subjects on reversal (their evidence sets separate cleanly — no blending ever
  // occurred). Exposed now so the read model is drivable + testable while the
  // reconcile writer is still absent (B3a is writer-less).
  async recomputeTrustState(subjectId: string, tenantId: string): Promise<void> {
    await this.recompute(subjectId, tenantId, new Date());
  }

  // ---- TR-12 B1 — the caseworker (DDR §3) ---------------------------------

  // The impure host of the pure generator (proposal-generator.ts). Reads the
  // three trigger signals for a subject (cluster-union, exactly as the dossier
  // reads them so a proposal aligns with what a human sees), calls the pure
  // policy engine, and upserts the desired proposals. READS + PROPOSAL WRITES
  // ONLY — it never invokes an action endpoint or service (propose-never-dispose,
  // structural). Invoked from BOTH sweep hosts post-recompute, each in its own
  // per-item try/catch. Silent (writes nothing) when no trigger fires. `now` is
  // injected so the time-driven RENEW is testable.
  async generateProposalsForSubject(
    subjectId: string,
    tenantId: string,
    now: Date = new Date(),
    // TR-12 B2 §3.0 — the host's name; stamped as the actor when a trigger-cleared
    // OPEN row is SETTLED. Defaults to the generator's own label off-host.
    hostActor = 'caseworker',
  ): Promise<VerificationProposalRow[]> {
    const trustState = await this.repo.findTrustStateBySubject(subjectId);
    // No TrustState yet means no recompute has run — nothing derived to act on.
    if (trustState === null) return [];

    const members = await this.repo.clusterMembers(subjectId);
    const evidence = await this.repo.listEvidenceBySubjects(members);

    // Open contradictions (basis = the evidence id) — the same cluster-union
    // CONTRADICTED set the dossier surfaces.
    const openContradictions: OpenContradiction[] = evidence
      .filter((e) => e.current_status === 'CONTRADICTED')
      .map((e) => ({ evidence_id: e.id, assertion_type: e.assertion_type }));

    // The cluster's EMAIL/PHONE anchors (a slot each), deduped by (kind, value);
    // the representative basis is the EARLIEST-created row (append-only anchors
    // are never mutated, so the earliest id is a stable basis across sweeps —
    // a later higher-class append for the same value does not change it).
    const anchorLists = await Promise.all(
      members.map((m) => this.repo.listAnchorsBySubject(m)),
    );
    const anchors = anchorLists
      .flat()
      .filter((a) => a.anchor_kind === 'EMAIL' || a.anchor_kind === 'PHONE');
    const bestAnchor = new Map<string, SubjectAnchorRow>();
    for (const a of anchors) {
      const key = `${a.anchor_kind} ${a.normalized_value}`;
      const cur = bestAnchor.get(key);
      const earlier =
        cur === undefined ||
        a.created_at.getTime() < cur.created_at.getTime() ||
        (a.created_at.getTime() === cur.created_at.getTime() && a.id < cur.id);
      if (earlier) bestAnchor.set(key, a);
    }

    // Current platform-verification acts (VALID EMAIL/PHONE_CONTROL_VERIFIED),
    // keyed by (assertion_type, normalized_value). is_stale uses the SAME 365d
    // threshold the flag derivation uses — the single source of the stale rule.
    const staleThresholdMs = VERIFICATION_STALE_DAYS * MS_PER_DAY;
    const verifByValue = new Map<string, Date>();
    for (const e of evidence) {
      if (e.current_status !== 'VALID') continue;
      if (
        e.assertion_type !== 'EMAIL_CONTROL_VERIFIED' &&
        e.assertion_type !== 'PHONE_CONTROL_VERIFIED'
      ) {
        continue;
      }
      const value = (e.assertion_payload as { normalized_value?: string } | null)
        ?.normalized_value;
      if (value === undefined) continue;
      verifByValue.set(`${e.assertion_type} ${value}`, e.collected_at);
    }

    const verificationSlots: VerificationSlot[] = [...bestAnchor.values()].map((a) => {
      const verifType =
        a.anchor_kind === 'EMAIL' ? 'EMAIL_CONTROL_VERIFIED' : 'PHONE_CONTROL_VERIFIED';
      const collectedAt = verifByValue.get(`${verifType} ${a.normalized_value}`);
      const has_current_verification = collectedAt !== undefined;
      const is_stale =
        collectedAt !== undefined &&
        now.getTime() - collectedAt.getTime() > staleThresholdMs;
      return {
        anchor_id: a.id,
        anchor_kind: a.anchor_kind,
        has_current_verification,
        is_stale,
      };
    });

    const desired = generateProposals(
      {
        single_source_only: trustState.single_source_only,
        verified_control_stale: trustState.verified_control_stale,
      },
      openContradictions,
      verificationSlots,
    );

    const written: VerificationProposalRow[] = [];
    for (const d of desired) {
      written.push(
        await this.repo.upsertProposal({
          tenant_id: tenantId,
          subject_id: subjectId,
          kind: d.kind,
          trigger_kind: d.trigger_kind,
          basis_ref_id: d.basis_ref_id,
          basis_snapshot: d.basis_snapshot,
          created_by: 'caseworker',
        }),
      );
    }

    // TR-12 B2 §3.0 — SETTLE the drift. Any OPEN proposal for this subject whose
    // (kind, basis) is NOT in the freshly-derived desired set means its trigger no
    // longer holds — the contradiction was resolved, the flag cleared, the slot got
    // verified, or the row was acted-but-unmarked. Settle it (terminal), so the
    // queue stays honest. Proposal-writes only — still executes nothing.
    const desiredKeys = new Set(desired.map((d) => `${d.kind}::${d.basis_ref_id}`));
    const openRows = await this.repo.listProposalsForSubject(tenantId, subjectId, {
      status: 'OPEN',
    });
    for (const row of openRows) {
      if (desiredKeys.has(`${row.kind}::${row.basis_ref_id}`)) continue;
      await this.repo.settleProposal({
        id: row.id,
        settled_by: hostActor,
        justification: PROPOSAL_SETTLED_JUSTIFICATION,
        now,
      });
    }
    return written;
  }

  // TR-12 B2 §3.1 — mark a proposal ACTED (bookkeeping only). The human already
  // invoked the real action through its own gated endpoint; this records that they
  // did, with the actor + an optional note. OPEN-only guard (reuse PROPOSAL_NOT_OPEN).
  // It EXECUTES NOTHING — no action endpoint, no service, no ledger write beyond the
  // proposal row's own transition (propose-never-dispose holds).
  async markProposalActed(input: {
    tenant_id: string;
    id: string;
    acted_by: string;
    note: string | null;
    requestId: string;
  }): Promise<VerificationProposalRow> {
    const existing = await this.repo.findProposalById(input.tenant_id, input.id);
    if (existing === null) {
      throw new AramoError('NOT_FOUND', 'proposal not found', 404, {
        requestId: input.requestId,
      });
    }
    if (existing.status !== 'OPEN') {
      throw new AramoError(
        'PROPOSAL_NOT_OPEN',
        `proposal is already ${existing.status} — cannot mark acted`,
        409,
        { requestId: input.requestId },
      );
    }
    return this.repo.applyProposalAct({
      id: existing.id,
      acted_by: input.acted_by,
      note: input.note,
      now: new Date(),
    });
  }

  // Dismiss a proposal (DDR §4) — the OPEN-only guard. A dismissed proposal never
  // nags (the upsert makes it a permanent no-op for that basis). Disposes of the
  // proposal ROW only — no ledger effect, no evidence, no merge (propose-never-
  // dispose). Tenant-scoped load-then-guard.
  async dismissProposal(input: {
    tenant_id: string;
    id: string;
    dismissed_by: string;
    justification: string;
    requestId: string;
  }): Promise<VerificationProposalRow> {
    const existing = await this.repo.findProposalById(input.tenant_id, input.id);
    if (existing === null) {
      throw new AramoError('NOT_FOUND', 'proposal not found', 404, {
        requestId: input.requestId,
      });
    }
    if (existing.status !== 'OPEN') {
      throw new AramoError(
        'PROPOSAL_NOT_OPEN',
        `proposal is already ${existing.status} — cannot dismiss`,
        409,
        { requestId: input.requestId },
      );
    }
    return this.repo.applyProposalDismissal({
      id: existing.id,
      dismissed_by: input.dismissed_by,
      justification: input.justification,
      now: new Date(),
    });
  }

  // The worklist keyset page (the API's list). Tenant-scoped; default OPEN;
  // optional kind/status filters; ordered by created_at only (R10).
  async listProposals(
    tenantId: string,
    opts: {
      status?: ProposalStatus;
      kind?: ProposalKind;
      cursor?: string;
      limit: number;
    },
  ): Promise<{ rows: VerificationProposalRow[]; nextCursor: string | null }> {
    return this.repo.listProposalsKeyset(tenantId, opts);
  }

  // Recompute the materialized TrustState from the full ledger. Never
  // hand-authored — always reconstructible from evidence + events.
  // TR-2a-B3a (DDR-3 §5) — CLUSTER-UNION: derive from the evidence of the WHOLE
  // cluster whose survivor is subjectId (the survivor + every subject merged into
  // it). For an unmerged subject the cluster is just itself → byte-identical to
  // the pre-B3a single-subject recompute. Evidence never moves; the union is a
  // read-time projection. The TrustState row is stored keyed to subjectId (the
  // survivor); a loser's frozen row persists as-is (reads follow to the survivor).
  private async recompute(subjectId: string, tenantId: string, now: Date): Promise<void> {
    const members = await this.repo.clusterMembers(subjectId);
    const evidence = await this.repo.listEvidenceBySubjects(members);
    const projection: EvidenceForDerivation[] = evidence.map((e) => ({
      dimension: e.dimension,
      source_class: e.source_class,
      method: e.method,
      // TR-3 (OPEN-6) — the assertion_type feeds the top-band registry gate.
      assertion_type: e.assertion_type,
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

  // TR-2a-B3a (DDR-3 §5) — resolve a ref to the ACTIVE FIXPOINT of its subject's
  // merge chain. The 1-hop follow (stop at merged_into's immediate target) is
  // RETIRED: an A→B→C chain now resolves to C, not B (the Q3.2 under-follow is
  // dead here as it already was in the resolver). resolveActiveFixpoint is
  // bounded (64) + cycle-guarded. A CYCLE/LIMIT anomaly FAILS LOUDLY — a silent
  // mis-resolve (reading a husk's stale trust) is worse than a raised error. This
  // read-resolver is also the promotion gate's resolve (promoteSubject →
  // resolveSubjectRef → here), so the gate globalizes with it.
  private async resolveSubjectForRead(subjectRef: SubjectRef): Promise<ResolutionSubjectRow | null> {
    const subject = await this.repo.findSubjectByRef(
      subjectRef.tenant_id,
      subjectRef.ref_type,
      subjectRef.ref_id,
    );
    if (subject === null) return null;
    // Fast path — an ACTIVE origin is its own fixpoint (no chain to follow).
    if (subject.status === 'ACTIVE') return subject;

    const fp = await this.repo.resolveActiveFixpoint(subject.id);
    if (fp.kind === 'ACTIVE') return this.repo.findSubjectById(fp.subjectId);
    if (fp.kind === 'CYCLE' || fp.kind === 'LIMIT') {
      // Loud fail — a merge-chain anomaly must never resolve to a plausible-but-
      // wrong subject. The reconcile (B3b) is what repairs the chain.
      this.logger.error(
        `resolveSubjectForRead fixpoint anomaly (${fp.kind}) origin=${subject.id} ref=${subjectRef.ref_type}:${subjectRef.ref_id} tenant=${subjectRef.tenant_id}`,
      );
      throw new Error(
        `resolveSubjectForRead: merge-chain ${fp.kind} for subject ${subject.id}`,
      );
    }
    // DEAD_END — a non-ACTIVE husk with no forward pointer (anomalous; a husk
    // should always point forward). Nothing live to read → null (logged).
    this.logger.warn(
      `resolveSubjectForRead fixpoint dead-end origin=${subject.id} ref=${subjectRef.ref_type}:${subjectRef.ref_id} tenant=${subjectRef.tenant_id}`,
    );
    return null;
  }

  private async requireEvidence(evidenceId: string): Promise<EvidenceRecordRow> {
    const ev = await this.repo.findEvidenceById(evidenceId);
    if (ev === null) {
      throw new NotFoundException(`EvidenceRecord ${evidenceId} not found`);
    }
    return ev;
  }

  // TR-2a-B3a (DDR-3 §2.3/§5) — INTENTIONAL NON-FOLLOWER: existence/identity
  // guard on a SPECIFIC subject id (merge/un-merge operands). It must see the
  // subject AS-IS (ACTIVE or MERGED), never its fixpoint — do NOT follow.
  private async requireSubject(subjectId: string): Promise<ResolutionSubjectRow> {
    const subject = await this.repo.findSubjectById(subjectId);
    if (subject === null) {
      throw new NotFoundException(`ResolutionSubject ${subjectId} not found`);
    }
    return subject;
  }

  // ==========================================================================
  // Portal P3a — talent verification view + dispute intake (§PR-1, rulings
  // 1-5 + Amendment v1.1). The caller's OPEN-4 subjects + cluster are supplied
  // by the portal resolver. NOTHING here touches TR-15 evidence state (P3a fires
  // NO transition). The wire projection strips every field on the ratified Q4
  // forbidden list (VERIFICATION_VIEW_FORBIDDEN_FIELDS) — enforced by a unit test.
  // ==========================================================================

  // Ruling 1 — the talent verification view: aggregate the caller's
  // verifications across their OPEN-4 chain, one item per DEDUPED contact anchor,
  // projected to kind + status + dates ONLY (an opaque item id, no verifier/
  // tenant/number/PII).
  async aggregateVerifications(
    callerSubjects: PortalCallerSubject[],
    clusterId: string,
  ): Promise<PortalVerificationItem[]> {
    const items = await this.enumerateVerificationItems(callerSubjects, clusterId);
    return items.map((it) => ({
      item_id: it.item_id,
      kind: it.kind,
      status: it.status,
      verified_at: it.verified_at,
      first_seen_at: it.first_seen_at,
    }));
  }

  // Ruling 2 — open a dispute against a view item. The opaque item id is resolved
  // by RE-ENUMERATING the caller's items and matching (one-way HMAC; nothing is
  // reversed); an id not in the caller's current view is a UNIFORM 404. Fans out
  // to N subject-scoped work items (ruling 3). One-open-per-item idempotency: a
  // still-open dispute on the same item is returned unchanged. NO TR-15
  // transition (Amendment v1.1 — disposition is P3b).
  async openPortalDispute(input: {
    clusterId: string;
    callerSubjects: PortalCallerSubject[];
    itemId: string;
    statement: string;
    now: Date;
    requestId: string;
  }): Promise<PortalDisputeRow> {
    const items = await this.enumerateVerificationItems(input.callerSubjects, input.clusterId);
    const target = items.find((it) =>
      portalVerificationItemIdMatches(input.itemId, it.item_id),
    );
    if (target === undefined) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    const existing = await this.repo.findOpenPortalDisputeForItem(
      input.clusterId,
      target.item_type,
      target.item_id,
    );
    if (existing !== null) return existing; // one-open-per-item (idempotent)
    const sla = this.computePortalDisputeSla(input.now);
    return this.repo.createPortalDispute({
      cluster_id: input.clusterId,
      item_type: target.item_type,
      item_id_digest: target.item_id,
      triage_due_at: sla.triage_due_at,
      summary_due_at: sla.summary_due_at,
      reinvestigation_due_at: sla.reinvestigation_due_at,
      ccpa_due_at: sla.ccpa_due_at,
      ccpa_extended_due_at: sla.ccpa_extended_due_at,
      work_items: target.fanout,
      statement: input.statement,
      statement_hash: this.hashPortalStatement(input.statement),
    });
  }

  async listPortalDisputes(
    clusterId: string,
    opts: { status?: string; limit: number },
  ): Promise<PortalDisputeRow[]> {
    return this.repo.listPortalDisputesByCluster(clusterId, opts);
  }

  async getPortalDispute(
    clusterId: string,
    disputeId: string,
    requestId: string,
  ): Promise<{ dispute: PortalDisputeRow; statements: PortalDisputeStatementRow[] }> {
    const dispute = await this.repo.findPortalDisputeInCluster(clusterId, disputeId);
    if (dispute === null) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId });
    }
    const statements = await this.repo.listPortalDisputeStatements(disputeId);
    return { dispute, statements };
  }

  // Respond: append a talent statement while the dispute is still open. Replaying
  // the identical latest statement is an idempotent no-op.
  async respondPortalDisputeStatement(input: {
    clusterId: string;
    disputeId: string;
    statement: string;
    requestId: string;
  }): Promise<PortalDisputeRow> {
    const dispute = await this.repo.findPortalDisputeInCluster(input.clusterId, input.disputeId);
    if (dispute === null) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    if (!(PORTAL_DISPUTE_OPEN_STATES as readonly string[]).includes(dispute.status)) {
      throw new AramoError(
        'PORTAL_DISPUTE_NOT_OPEN',
        'this dispute is closed and can no longer be responded to',
        422,
        { requestId: input.requestId },
      );
    }
    const hash = this.hashPortalStatement(input.statement);
    const existing = await this.repo.listPortalDisputeStatements(input.disputeId);
    const last = existing[existing.length - 1];
    if (last === undefined || last.statement_hash !== hash) {
      await this.repo.appendPortalDisputeStatement(input.disputeId, input.statement, hash);
    }
    return dispute;
  }

  // Withdraw: terminal talent action. Already-terminal is an idempotent no-op.
  // W-2 (Amendment v1.2): end-state-conditional — a work item currently DISPUTED
  // (post-triage) is resolveDispute('rejected') back to VALID; a pre-triage
  // (still-OPEN) item needs no TR-15 call. Pin A: the withdrawal-fired resolve
  // records the PORTAL PRINCIPAL as actor + a talent-withdrawal justification —
  // the audit must read as a withdrawal, never a resolver disposition.
  async withdrawPortalDispute(input: {
    clusterId: string;
    disputeId: string;
    actor: string; // the portal principal (Pin A)
    now: Date;
    requestId: string;
  }): Promise<PortalDisputeRow> {
    const dispute = await this.repo.findPortalDisputeInCluster(input.clusterId, input.disputeId);
    if (dispute === null) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    if (!(PORTAL_DISPUTE_OPEN_STATES as readonly string[]).includes(dispute.status)) {
      return dispute; // idempotent: already terminal
    }
    const items = await this.repo.findAllWorkItemsForDispute(input.disputeId);
    for (const wi of items) {
      // Only UNDER_REVIEW items had trust.dispute() fired at triage (evidence
      // DISPUTED); OPEN items never left VALID (the §2 end-state) — no call.
      if (wi.status !== 'UNDER_REVIEW') continue;
      const evidenceId = await this.resolveWorkItemEvidenceId(wi);
      if (evidenceId === null) continue;
      try {
        await this.resolveDispute(
          evidenceId,
          input.actor,
          'rejected',
          PORTAL_DISPUTE_WITHDRAWAL_JUSTIFICATION,
          input.requestId,
        );
      } catch {
        // best-effort: not DISPUTED / not disputable — the item is already safe.
      }
    }
    return this.repo.withdrawPortalDispute(input.disputeId, input.now);
  }

  // =========================================================================
  // Portal P3b — TENANT-side disposition (§PR-2 + Amendment v1.2). The tenant
  // acts on their work items (subject-keyed) for a dispute; each disposition is
  // a recorded human action (PROPOSE/DISPOSE). The §2 outcome→TR-15 mapping is
  // PORTAL_DISPUTE_OUTCOME_MAP (asserted verbatim by the mandatory tripwire).
  // =========================================================================

  // The VR→evidence bridge (Amendment v1.2). Returns the backing EvidenceRecord
  // id for a work item, or null if it cannot be resolved (defensive).
  private async resolveWorkItemEvidenceId(
    wi: PortalDisputeWorkItemRow,
  ): Promise<string | null> {
    if (wi.item_type === 'ANCHOR') {
      const anchor = await this.repo.findAnchorById(wi.tenant_id, wi.underlying_ref_id);
      return anchor?.source_evidence_id ?? null;
    }
    // VERIFICATION: VR.id → the PLATFORM_VERIFIED anchor for its (subject,kind,value).
    const vr = await this.repo.findVerificationRequestById(wi.underlying_ref_id);
    if (vr === null) return null;
    const anchor = await this.repo.findSubjectAnchor(
      vr.tenant_id,
      vr.subject_id,
      vr.anchor_kind,
      vr.normalized_value,
      'PLATFORM_VERIFIED',
    );
    return anchor?.source_evidence_id ?? null;
  }

  // Triage (W-1): fire trust.dispute() per OPEN work item → UNDER_REVIEW. A work
  // item whose backing evidence is not disputable lands RESOLVED_NO_TRANSITION
  // (Pin B). The parent goes UNDER_REVIEW (or rolls up if every item is terminal).
  async triagePortalDispute(input: {
    tenantId: string;
    disputeId: string;
    actor: string;
    requestId: string;
  }): Promise<PortalDisputeRow> {
    const items = await this.repo.findTenantWorkItemsForDispute(input.tenantId, input.disputeId);
    if (items.length === 0) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    for (const wi of items) {
      if (wi.status !== 'OPEN') continue;
      const evidenceId = await this.resolveWorkItemEvidenceId(wi);
      if (evidenceId === null) {
        await this.repo.advancePortalWorkItemStatus(wi.id, 'RESOLVED_NO_TRANSITION', 'backing evidence not resolvable');
        continue;
      }
      try {
        await this.dispute(evidenceId, input.actor, 'talent dispute — triaged for review', input.requestId);
        await this.repo.advancePortalWorkItemStatus(wi.id, 'UNDER_REVIEW');
      } catch (err) {
        if (err instanceof AramoError && err.code === 'EVIDENCE_NOT_DISPUTABLE') {
          await this.repo.advancePortalWorkItemStatus(wi.id, 'RESOLVED_NO_TRANSITION', 'evidence not disputable');
        } else {
          throw err;
        }
      }
    }
    return this.rollupParentDispute(input.disputeId, 'UNDER_REVIEW');
  }

  // Request-info: a recorded reviewer note on the dispute thread (author TENANT).
  // No status/TR-15 change — the dispute stays UNDER_REVIEW awaiting the talent.
  async requestInfoPortalDispute(input: {
    tenantId: string;
    disputeId: string;
    note: string;
    requestId: string;
  }): Promise<PortalDisputeRow> {
    const items = await this.repo.findTenantWorkItemsForDispute(input.tenantId, input.disputeId);
    if (items.length === 0) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    await this.repo.appendPortalDisputeStatement(
      input.disputeId,
      input.note,
      this.hashPortalStatement(input.note),
      'TENANT',
    );
    const dispute = await this.repo.findPortalDisputeById(input.disputeId);
    return dispute!;
  }

  // Dispose (correct | uphold): resolveDispute per UNDER_REVIEW work item per the
  // §2 map, then roll up. RESOLVED_CORRECTED→'upheld'→REVOKED;
  // RESOLVED_UPHELD→'rejected'→VALID. Non-DISPUTED items → RESOLVED_NO_TRANSITION.
  async disposePortalDispute(input: {
    tenantId: string;
    disputeId: string;
    outcome: 'RESOLVED_CORRECTED' | 'RESOLVED_UPHELD';
    note: string;
    actor: string;
    requestId: string;
  }): Promise<PortalDisputeRow> {
    const items = await this.repo.findTenantWorkItemsForDispute(input.tenantId, input.disputeId);
    if (items.length === 0) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    const tr15Outcome = PORTAL_DISPUTE_OUTCOME_MAP[input.outcome].tr15Outcome;
    for (const wi of items) {
      if (wi.status !== 'UNDER_REVIEW') continue; // only triaged items are disposable
      const evidenceId = await this.resolveWorkItemEvidenceId(wi);
      if (evidenceId === null) {
        await this.repo.advancePortalWorkItemStatus(wi.id, 'RESOLVED_NO_TRANSITION', 'backing evidence not resolvable');
        continue;
      }
      try {
        await this.resolveDispute(evidenceId, input.actor, tr15Outcome, input.note, input.requestId);
        await this.repo.advancePortalWorkItemStatus(wi.id, input.outcome);
      } catch (err) {
        if (err instanceof AramoError && err.code === 'EVIDENCE_NOT_DISPUTED') {
          await this.repo.advancePortalWorkItemStatus(wi.id, 'RESOLVED_NO_TRANSITION', 'evidence not in DISPUTED state');
        } else {
          throw err;
        }
      }
    }
    return this.rollupParentDispute(input.disputeId, 'UNDER_REVIEW', input.note);
  }

  // The single reinvestigation extension (+15d, ruling 5), recorded when taken.
  async extendPortalDisputeReinvestigation(input: {
    tenantId: string;
    disputeId: string;
    now: Date;
    requestId: string;
  }): Promise<PortalDisputeRow> {
    const items = await this.repo.findTenantWorkItemsForDispute(input.tenantId, input.disputeId);
    if (items.length === 0) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    const dispute = await this.repo.findPortalDisputeById(input.disputeId);
    if (dispute === null) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    if (dispute.reinvestigation_extended_at !== null) {
      throw new AramoError(
        'PORTAL_DISPUTE_EXTENSION_USED',
        'the single reinvestigation extension has already been taken',
        422,
        { requestId: input.requestId },
      );
    }
    const newDue = new Date(
      dispute.reinvestigation_due_at.getTime() +
        PORTAL_DISPUTE_SLA.reinvestigationExtensionDays * 86_400_000,
    );
    return this.repo.extendPortalDisputeReinvestigation(input.disputeId, newDue, input.now);
  }

  // The tenant worklist: distinct disputes with a work item in this tenant.
  async listTenantDisputeWorkItems(
    tenantId: string,
    opts: { open: boolean; limit: number },
  ): Promise<PortalDisputeWorkItemRow[]> {
    const statuses = opts.open
      ? PORTAL_DISPUTE_OPEN_STATES
      : PORTAL_DISPUTE_WORK_ITEM_STATES;
    return this.repo.findTenantDisputeWorkItems(tenantId, { statuses, limit: opts.limit });
  }

  // One dispute the tenant holds a work item for (membership via the work item).
  async getTenantDispute(input: {
    tenantId: string;
    disputeId: string;
    requestId: string;
  }): Promise<{ dispute: PortalDisputeRow; workItems: PortalDisputeWorkItemRow[]; statements: PortalDisputeStatementRow[] }> {
    const workItems = await this.repo.findTenantWorkItemsForDispute(input.tenantId, input.disputeId);
    if (workItems.length === 0) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    const dispute = await this.repo.findPortalDisputeById(input.disputeId);
    if (dispute === null) {
      throw new AramoError('NOT_FOUND', 'not found', 404, { requestId: input.requestId });
    }
    const statements = await this.repo.listPortalDisputeStatements(input.disputeId);
    return { dispute, workItems, statements };
  }

  // Parent rollup: if EVERY work item (across all tenants) is terminal, set the
  // parent to RESOLVED_CORRECTED (if any item corrected) else RESOLVED_UPHELD,
  // stamping the resolution note. Otherwise the parent sits at `interim`.
  private async rollupParentDispute(
    disputeId: string,
    interim: string,
    resolutionNote?: string,
  ): Promise<PortalDisputeRow> {
    const all = await this.repo.findAllWorkItemsForDispute(disputeId);
    const terminal = (s: string): boolean =>
      !(PORTAL_DISPUTE_OPEN_STATES as readonly string[]).includes(s);
    if (all.every((wi) => terminal(wi.status))) {
      const parentStatus = all.some((wi) => wi.status === 'RESOLVED_CORRECTED')
        ? 'RESOLVED_CORRECTED'
        : 'RESOLVED_UPHELD';
      return this.repo.setPortalDisputeParentStatus(disputeId, parentStatus, resolutionNote);
    }
    return this.repo.setPortalDisputeParentStatus(disputeId, interim, resolutionNote);
  }

  // Enumerate the caller's view items WITH the server-side fan-out (tenant/
  // subject/underlying ids) both the wire projection and dispute-open resolve.
  private async enumerateVerificationItems(
    callerSubjects: PortalCallerSubject[],
    clusterId: string,
  ): Promise<EnumeratedVerificationItem[]> {
    type Hit = {
      tenant_id: string;
      subject_id: string;
      anchor: SubjectAnchorRow;
      vr: VerificationRequestRow | null;
    };
    const hits: Hit[] = [];
    for (const s of callerSubjects) {
      const anchors = (await this.repo.listAnchorsBySubject(s.subject_id)).filter((a) =>
        (CONTACT_ANCHOR_KINDS as readonly string[]).includes(a.anchor_kind),
      );
      for (const a of anchors) {
        const vr = await this.repo.findLatestVerificationRequest(
          s.tenant_id,
          a.subject_id,
          a.anchor_kind,
          a.normalized_value,
        );
        hits.push({ tenant_id: s.tenant_id, subject_id: s.subject_id, anchor: a, vr });
      }
    }
    // Group by DEDUP identity (kind + normalized value). The value is PII — used
    // ONLY as a grouping key here, never emitted or persisted on the wire.
    const groups = new Map<string, Hit[]>();
    for (const h of hits) {
      const key = `${h.anchor.anchor_kind} ${h.anchor.normalized_value}`;
      const g = groups.get(key);
      if (g === undefined) groups.set(key, [h]);
      else g.push(h);
    }
    const out: EnumeratedVerificationItem[] = [];
    for (const g of groups.values()) {
      const kind = g[0]!.anchor.anchor_kind;
      const confirmed = g.filter((h) => h.vr?.status === 'CONFIRMED');
      const itemType: PortalDisputeItemType = confirmed.length > 0 ? 'VERIFICATION' : 'ANCHOR';
      const rows = itemType === 'VERIFICATION' ? confirmed : g;
      const fanout = rows.map((h) => ({
        tenant_id: h.tenant_id,
        subject_id: h.subject_id,
        underlying_ref_id: itemType === 'VERIFICATION' ? h.vr!.id : h.anchor.id,
      }));
      const item_id = mintPortalVerificationItemId({
        clusterId,
        itemType,
        underlyingRefIds: fanout.map((f) => f.underlying_ref_id),
      });
      const status =
        confirmed.length > 0
          ? 'CONFIRMED'
          : g.some((h) => h.vr?.status === 'PENDING')
            ? 'PENDING'
            : 'NONE';
      const verified_at =
        confirmed.length > 0 ? isoMaxDate(confirmed.map((h) => h.vr!.consumed_at)) : null;
      const first_seen_at = isoMinDate(g.map((h) => h.anchor.created_at));
      out.push({ item_id, item_type: itemType, kind, status, verified_at, first_seen_at, fanout });
    }
    // Stable order (by item_id) so the wire list is deterministic.
    out.sort((a, b) => (a.item_id < b.item_id ? -1 : a.item_id > b.item_id ? 1 : 0));
    return out;
  }

  private computePortalDisputeSla(now: Date): {
    triage_due_at: Date;
    summary_due_at: Date;
    reinvestigation_due_at: Date;
    ccpa_due_at: Date | null;
    ccpa_extended_due_at: Date | null;
  } {
    const day = 86_400_000;
    const t = now.getTime();
    return {
      triage_due_at: new Date(t + PORTAL_DISPUTE_SLA.triageDueDays * day),
      summary_due_at: new Date(t + PORTAL_DISPUTE_SLA.summaryDueDays * day),
      reinvestigation_due_at: new Date(t + PORTAL_DISPUTE_SLA.reinvestigationDueDays * day),
      // CCPA 45+45: the initial clock starts at open; the +45 extension is taken
      // (recorded) tenant-side in P3b, never at open.
      ccpa_due_at: new Date(t + PORTAL_DISPUTE_SLA.ccpaInitialDays * day),
      ccpa_extended_due_at: null,
    };
  }

  private hashPortalStatement(statement: string): string {
    return createHash('sha256').update(statement, 'utf8').digest('hex');
  }
}

// TR-2a-B2 — strongest source_class among a target's anchors for a value
// (SOURCE_CLASSES is ordered worthless→authoritative; the max index wins). The
// group is non-empty (the caller built it from ≥1 hit anchor).
function strongestAnchorClass(anchors: readonly SubjectAnchorRow[]): SourceClass {
  let best = anchors[0]!.source_class;
  for (const a of anchors) {
    if (SOURCE_CLASSES.indexOf(a.source_class) > SOURCE_CLASSES.indexOf(best)) {
      best = a.source_class;
    }
  }
  return best;
}

// ===========================================================================
// Portal P3a — verification-view + dispute wire types (talent-facing).
// ===========================================================================

// The caller's OPEN-4 subjects (from the portal resolver's resolveSubjects).
export interface PortalCallerSubject {
  tenant_id: string;
  subject_id: string;
}

// The re-projected verification-view item (ruling 1): kind + status + dates +
// an opaque server-minted item id. NOTHING else crosses.
export interface PortalVerificationItem {
  item_id: string;
  kind: string; // anchor_kind (EMAIL | PHONE | PROFILE_URL) — never a value
  status: string; // CONFIRMED | PENDING | NONE — no tier/strength/number
  verified_at: string | null;
  first_seen_at: string | null;
}

// The server-side enumeration (item + fan-out). NEVER emitted whole — the wire
// projection (aggregateVerifications) drops item_type + fanout.
export interface EnumeratedVerificationItem {
  item_id: string;
  item_type: PortalDisputeItemType;
  kind: string;
  status: string;
  verified_at: string | null;
  first_seen_at: string | null;
  fanout: { tenant_id: string; subject_id: string; underlying_ref_id: string }[];
}

// The ratified Q4 re-projection forbidden list (Amendment v1.1 §3, binding). A
// unit test asserts no PortalVerificationItem key intersects this set — a future
// field addition that leaks origin/verifier/number/PII goes red.
export const VERIFICATION_VIEW_FORBIDDEN_FIELDS: readonly string[] = [
  'tenant_id',
  'tenant_name',
  'subject_id',
  'created_by',
  'resolved_by',
  'verifier',
  'verified_by',
  'strength',
  'source_class',
  'normalized_value',
  'token_hash',
  'talent_record_id',
  'open_contradiction_count',
  'stale_evidence_count',
  'underlying_ref_id',
];

function isoMaxDate(dates: (Date | null)[]): string | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (d === null) continue;
    if (best === null || d.getTime() > best.getTime()) best = d;
  }
  return best === null ? null : best.toISOString();
}

function isoMinDate(dates: (Date | null)[]): string | null {
  let best: Date | null = null;
  for (const d of dates) {
    if (d === null) continue;
    if (best === null || d.getTime() < best.getTime()) best = d;
  }
  return best === null ? null : best.toISOString();
}

// ===========================================================================
// Portal P3b — the Amendment v1.1 §2 outcome-mapping table, ENCODED. The tenant
// disposition (disposePortalDispute) + candidate withdraw wire to TR-15 through
// this map. The mandatory tripwire (portal-dispute-mapping.spec.ts) asserts all
// three rows VERBATIM — the "upheld" inversion (candidate-visible = the ITEM
// upheld; TR-15 = the DISPUTE upheld) goes red if a sense is flipped.
// ===========================================================================
export const PORTAL_DISPUTE_OUTCOME_MAP = {
  // The candidate was right; the item was wrong → the DISPUTE is upheld → REVOKED.
  RESOLVED_CORRECTED: { tr15Outcome: 'upheld' as const, itemEndState: 'REVOKED' as const },
  // The item stands; the dispute is rejected → DISPUTE_RESOLVED → VALID.
  RESOLVED_UPHELD: { tr15Outcome: 'rejected' as const, itemEndState: 'VALID' as const },
  // The talent withdraws → treated as rejected → DISPUTE_RESOLVED → VALID.
  WITHDRAWN: { tr15Outcome: 'rejected' as const, itemEndState: 'VALID' as const },
} as const;

// Pin A — the justification stamped on a withdrawal-fired resolveDispute so the
// audit event reads as a talent withdrawal, never a resolver disposition.
export const PORTAL_DISPUTE_WITHDRAWAL_JUSTIFICATION =
  'talent withdrawal — dispute withdrawn by the portal principal';
