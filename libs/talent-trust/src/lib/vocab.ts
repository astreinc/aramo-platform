// Closed vocabularies for the talent-trust module (TR-1, §5.2–5.5).
//
// PO Ruling 2: every closed vocabulary is a String column at the Prisma
// layer, enforced here as a TS union + a readonly `const` array suitable for
// class-validator's `@IsIn(...)`. No Prisma native enums anywhere in this
// module. The arrays are the single source of truth for both the type
// (via `typeof […][number]`) and the runtime DTO guard.

// ---- ResolutionSubject.status (§5.1) ----------------------------------------
export const RESOLUTION_SUBJECT_STATUSES = ['ACTIVE', 'MERGED', 'SUPERSEDED'] as const;
export type ResolutionSubjectStatus = (typeof RESOLUTION_SUBJECT_STATUSES)[number];

// ---- ResolutionSubjectRef.ref_type (§5.1) -----------------------------------
// ATS-as-heart / Core-as-index: ATS_TALENT_RECORD is the system-of-record ref
// (the heart); PERSON_CLUSTER is a tenant-spanning person-cluster index ref
// (NOT a Core-Talent-SOR ref); ANCHOR is a minted trust-layer anchor.
// SOURCED_TALENT (Fix-Slice-1) is an L1 staging-arrival ref (a sourced_talent
// row) — the PRE-PROMOTION attachment point: evidence attaches to a subject
// keyed to a raw channel arrival BEFORE any TalentRecord exists (Lifecycle
// Spec v1.1 §3.2 / §5). Ref value is the sourced_talent arrival UUID
// (cross-schema, UUID-only, no FK — I1).
export const RESOLUTION_SUBJECT_REF_TYPES = [
  'ATS_TALENT_RECORD',
  'PERSON_CLUSTER',
  'ANCHOR',
  'SOURCED_TALENT',
] as const;
export type ResolutionSubjectRefType = (typeof RESOLUTION_SUBJECT_REF_TYPES)[number];

// ---- EvidenceRecord.dimension (§5.1 / R1 — four) -----------------------
export const TRUST_DIMENSIONS = ['IDENTITY', 'CLAIMS', 'CONTINUITY', 'ELIGIBILITY'] as const;
export type TrustDimension = (typeof TRUST_DIMENSIONS)[number];

// ---- SubjectAnchor.anchor_kind (TR-2a-1) -------------------------------
// The within-tenant identifier anchors the matcher keys on. Doubles as the
// anchor EvidenceRecord's assertion_type (dimension = IDENTITY). EMAIL/PHONE
// only in this slice; more identifier kinds register in later slices.
export const ANCHOR_KINDS = ['EMAIL', 'PHONE'] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

// ---- SubjectMatchAdvisory.advise_band (TR-2a-2) -----------------------
// Split-biased / inclusive on ADVISE (advisories never merge — R4). One shared
// anchor = ADVISE_WEAK; multiple / multi-kind shared anchors = ADVISE_STRONG.
// ADVISORY METADATA ONLY — gates nothing (nothing merges); orders a reviewer queue.
export const MATCH_ADVISE_BANDS = ['ADVISE_WEAK', 'ADVISE_STRONG'] as const;
export type MatchAdviseBand = (typeof MATCH_ADVISE_BANDS)[number];

// ---- SubjectMatchAdvisory.status (TR-2a-2 seed → TR-2a-3 lifecycle) ----
// Lifecycle (R5): PENDING_REVIEW → { MERGED (approved+executed) | DISMISSED
// (reviewer: not same human) }; a MERGED advisory whose merge is later reversed
// → REVERSED (history preserved, never deleted). TR-2a-2 wrote PENDING_REVIEW
// only; TR-2a-3 adds the human-driven transitions. (The TR-2a-2 placeholder
// 'CONFIRMED' — never written — is replaced by the executed-merge terminal
// 'MERGED'.)
export const MATCH_ADVISORY_STATUSES = [
  'PENDING_REVIEW',
  'MERGED',
  'DISMISSED',
  'REVERSED',
] as const;
export type MatchAdvisoryStatus = (typeof MATCH_ADVISORY_STATUSES)[number];

// ---- Corroborator conflict kinds (TR-2a-B2, DDR-2 Amendment §2.3) ------
// A STRONG-corroborator conflict contributed by the RESOLVER (not the anchor
// classifier) into an advisory's match_basis + has_contradiction. NAME only in
// this slice — the problem statement's named case (§4-b3). Additional kinds
// (address, employer) join only by a further amendment with their own predicate.
export const CORROBORATOR_CONFLICT_KINDS = ['NAME'] as const;
export type CorroboratorConflictKind = (typeof CORROBORATOR_CONFLICT_KINDS)[number];

// ---- SubjectMergeOperation.kind (TR-6 B1, DDR §5) ---------------------
// Discriminates the record-reconcile flow (RECONCILE — the default; the
// orchestrator's heavy operation record) from the pointer-only merge capability
// finally leaving a trail: DIRECT_MERGE (mergeSubjects) and DIRECT_UNMERGE
// (unmergeSubjects with no prior operation-backed row). A direct merge writes a
// minimal PENDING row that the orchestrator ENRICHES if a record-reconcile
// follows (the approve→reconcile path); a standalone direct merge/unmerge is the
// full audit trail. String-backed, additive at this layer (no DB CHECK).
export const MERGE_OPERATION_KINDS = [
  'RECONCILE',
  'DIRECT_MERGE',
  'DIRECT_UNMERGE',
] as const;
export type MergeOperationKind = (typeof MERGE_OPERATION_KINDS)[number];

// ---- SubjectMatchAdvisory.resolution_action (TR-2a-3) -----------------
// The human action recorded on the advisory (R4 audit). MERGE = approve →
// executed pointer-only mergeSubjects; DISMISS = reviewer judged not-same-human;
// REVERSE = a prior MERGE was un-merged (unmergeSubjects), advisory → REVERSED.
export const MATCH_RESOLUTION_ACTIONS = ['MERGE', 'DISMISS', 'REVERSE'] as const;
export type MatchResolutionAction = (typeof MATCH_RESOLUTION_ACTIONS)[number];

// ---- EvidenceRecord.source_class — the independence ladder (§5.2) ------
// ORDERED worthless → authoritative. The ordering is fixed (R2); the index
// in this array IS the ladder position used by strength + band derivation.
// The ladder position is POSITIONAL and RELATIVE — nothing persists a numeric
// position value, so a ladder insertion is safe (the ordinal is computed at read
// time via SOURCE_CLASSES.indexOf, never stored).
//
// TR-3 (DDR-1 Amendment v1.2 §6.1) — PLATFORM_VERIFIED admitted with its
// producer, inserted BETWEEN THIRD_PARTY_VERIFIED and AUTHORITATIVE_ISSUER: the
// platform performed the verification act itself (stronger than trusting a
// channel's flag), but a mailbox round-trip is not an authoritative identity
// document (weaker than an issuer). Yields CORROBORATED on IDENTITY via the
// existing ≥THIRD_PARTY_VERIFIED gate — an honest "platform-verified email
// control", never more.
export const SOURCE_CLASSES = [
  'SELF',
  'THIRD_PARTY_UNVERIFIED',
  'THIRD_PARTY_VERIFIED',
  'PLATFORM_VERIFIED',
  'AUTHORITATIVE_ISSUER',
  'CRYPTOGRAPHIC',
  'BIOMETRIC',
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

// ---- EvidenceRecord.method (§5.3) --------------------------------------
// TR-3 (DDR-1 Amendment v1.2 §6.3) — CONTROL_ROUND_TRIP: the platform proved
// control of a channel by a round-trip (a link sent to the address and clicked
// back). Deterministic (it either completed or did not — no LLM); the method
// PLATFORM_VERIFIED email/phone verification is obtained by.
export const METHODS = [
  'SELF_DECLARED',
  'DOCUMENT',
  'API_REGISTRY',
  'SIGNATURE',
  'BIOMETRIC',
  'HUMAN_ATTESTED',
  'CONTROL_ROUND_TRIP',
] as const;
export type Method = (typeof METHODS)[number];

// ---- assertion_type — extensible starter set (§5.3) --------------------
// Extensible: later slices register more. The DTO does NOT @IsIn-gate
// assertion_type against this list (that would defeat extensibility); the
// list documents the TR-1 seed set and is exported for downstream reuse.
export const SEED_ASSERTION_TYPES = [
  'PHONE_VERIFIED',
  'SKILL',
  'EMPLOYMENT',
  'DEGREE',
  'CERTIFICATION',
  'FACE_MATCH',
  'LIVENESS',
  'RIGHT_TO_WORK',
  'IDENTITY_DOCUMENT',
  // TR-3 (DDR §2.5) — the platform email/phone control-verification assertions
  // the PLATFORM_VERIFIED producer mints (EMAIL ships in v1; PHONE is reserved).
  'EMAIL_CONTROL_VERIFIED',
  'PHONE_CONTROL_VERIFIED',
] as const;
export type SeedAssertionType = (typeof SEED_ASSERTION_TYPES)[number];

// ---- EvidenceRecord.decay_profile (§7) ---------------------------------
export const DECAY_PROFILES = ['DURABLE', 'SLOW', 'MODERATE', 'FAST', 'PER_STEP'] as const;
export type DecayProfile = (typeof DECAY_PROFILES)[number];

// ---- EvidenceRecord.portability_class (§5.1 / §9) ----------------------
export const PORTABILITY_CLASSES = ['TENANT_ONLY', 'ATTESTATION_PORTABLE'] as const;
export type PortabilityClass = (typeof PORTABILITY_CLASSES)[number];

// ---- EvidenceRecord.current_status (§5.5) ------------------------------
export const EVIDENCE_STATUSES = [
  'PENDING',
  'VALID',
  'STALE',
  'CONTRADICTED',
  'REVOKED',
  'SUPERSEDED',
  'DISPUTED',
] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

// ---- EvidenceEvent.event_type (§5.1) -----------------------------------
export const EVIDENCE_EVENT_TYPES = [
  'CREATED',
  'VALIDATED',
  'MARKED_STALE',
  'CONTRADICTED',
  'REVOKED',
  'SUPERSEDED',
  'DISPUTED',
  'DISPUTE_RESOLVED',
  // TR-4 B1 (DDR §2.4) — the closure arm the contradiction machinery has lacked
  // since TR-1. A human (B3's resolve API) applies it to a CONTRADICTED record;
  // it projects back to VALID (below), lifting the CORROBORATED cap on recompute.
  // Distinct from DISPUTE_RESOLVED (a separate axis — DISPUTED, not CONTRADICTED).
  'CONTRADICTION_RESOLVED',
] as const;
export type EvidenceEventType = (typeof EVIDENCE_EVENT_TYPES)[number];

// ---- EvidenceLink.relation (§5.1) --------------------------------------
export const EVIDENCE_LINK_RELATIONS = ['CORROBORATES', 'CONTRADICTS', 'SUPERSEDES'] as const;
export type EvidenceLinkRelation = (typeof EVIDENCE_LINK_RELATIONS)[number];

// ---- TrustState bands — PresentationBand (§5.4, per dimension) ---------
// ORDERED lowest → highest. The index IS the band position (band derivation
// compares and caps by position).
export const PRESENTATION_BANDS = [
  'NOT_ESTABLISHED',
  'SELF_ASSERTED',
  'CORROBORATED',
  'INDEPENDENTLY_VERIFIED',
  'AUTHORITATIVE',
] as const;
export type PresentationBand = (typeof PRESENTATION_BANDS)[number];

// ---- Lifecycle event → projected status map (§5.5) ---------------------
// `current_status` is set ONLY by applying an EvidenceEvent. This is the
// projection: the latest event's type maps to the record's status.
export const EVENT_TO_STATUS: Record<EvidenceEventType, EvidenceStatus> = {
  CREATED: 'VALID',
  VALIDATED: 'VALID',
  MARKED_STALE: 'STALE',
  CONTRADICTED: 'CONTRADICTED',
  REVOKED: 'REVOKED',
  SUPERSEDED: 'SUPERSEDED',
  DISPUTED: 'DISPUTED',
  DISPUTE_RESOLVED: 'VALID',
  // TR-4 B1 (DDR §2.4) — a resolved contradiction returns the record to VALID
  // (the same terminal DISPUTE_RESOLVED uses): the record re-accrues and the
  // dimension's CORROBORATED cap lifts on the next recompute.
  CONTRADICTION_RESOLVED: 'VALID',
};

// ---- OPEN-6: the per-dimension authoritative-assertion-type registry --------
// TR-3 (DDR §3) — a PURE engine map (the EVENT_TO_STATUS pattern): the closed
// set of assertion_types that may LIFT a dimension into the top two bands. It
// gates band ELEVATION, not ingestion — `assertion_type` stays a free string at
// the DTO (extensibility preserved, see SEED_ASSERTION_TYPES above); an
// UNregistered type records as evidence normally but cannot raise a dimension to
// INDEPENDENTLY_VERIFIED or AUTHORITATIVE. This adds a *what-was-asserted*
// requirement on top of the existing *how-it-arrived* (source_class) gate.
//
// NOT tenant-configurable (trust semantics never are — I2/I5 spirit). Registry
// changes are DDR-amendment-level edits, reviewed like the channel map. A dimension
// with an EMPTY set (CONTINUITY today) keeps its top gates UNREACHABLE — fail-closed:
// TR-5/TR-8 populate it. Seed sets per DDR §3.
export const AUTHORITATIVE_ASSERTION_TYPES: Record<TrustDimension, readonly string[]> = {
  IDENTITY: [
    'IDENTITY_DOCUMENT',
    'FACE_MATCH',
    'LIVENESS',
    'EMAIL_CONTROL_VERIFIED',
    'PHONE_CONTROL_VERIFIED',
  ],
  CLAIMS: ['DEGREE', 'CERTIFICATION', 'EMPLOYMENT'],
  CONTINUITY: [],
  ELIGIBILITY: ['RIGHT_TO_WORK'],
};
