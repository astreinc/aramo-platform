import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { isConfirmingAnchor } from './anchor-confirmation.js';
import { validateClaimShape } from './canonical-claim-shapes.js';
import {
  computeConsistencyPlan,
  REASON_EMPLOYER_CONFLICT_SAME_WINDOW,
  REASON_IMPOSSIBLE_RANGE,
  type EmploymentClaim,
  type ExistingGap,
} from './consistency-detectors.js';
import {
  deriveTrustState,
  type EvidenceForDerivation,
} from './band-derivation.js';
import { namesFlatlyConflict } from './name-guard.js';
import { deriveStrength } from './strength.js';
import {
  SubjectMatcherService,
  type CorroboratorConflictsByTarget,
} from './subject-matcher.service.js';
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
  SOURCE_CLASSES,
  type AnchorKind,
  type CorroboratorConflictKind,
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
    }

    await this.recompute(claimed.subject_id, claimed.tenant_id, now);
    return {
      verified: true,
      subject_id: claimed.subject_id,
      tenant_id: claimed.tenant_id,
    };
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

  async dispute(evidenceId: string, reason: string): Promise<void> {
    await this.applyLifecycle(evidenceId, 'DISPUTED', { reason });
  }

  async resolveDispute(evidenceId: string, outcome: string): Promise<void> {
    await this.applyLifecycle(evidenceId, 'DISPUTE_RESOLVED', { reason: outcome });
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

    await this.recompute(subjectId, tenantId, new Date());
    return {
      contradictions: plan.impossibleRangeIds.length + plan.employerConflicts.length,
      gaps_opened,
      gaps_healed: plan.gapsToHeal.length,
    };
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
