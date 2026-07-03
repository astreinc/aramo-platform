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
export const RESOLUTION_SUBJECT_REF_TYPES = ['ATS_TALENT_RECORD', 'PERSON_CLUSTER', 'ANCHOR'] as const;
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

// ---- SubjectMatchAdvisory.status (TR-2a-2) ----------------------------
// This slice writes PENDING_REVIEW ONLY; TR-2a-3 transitions it (append-only-style).
export const MATCH_ADVISORY_STATUSES = ['PENDING_REVIEW', 'CONFIRMED', 'DISMISSED'] as const;
export type MatchAdvisoryStatus = (typeof MATCH_ADVISORY_STATUSES)[number];

// ---- EvidenceRecord.source_class — the independence ladder (§5.2) ------
// ORDERED worthless → authoritative. The ordering is fixed (R2); the index
// in this array IS the ladder position used by strength + band derivation.
export const SOURCE_CLASSES = [
  'SELF',
  'THIRD_PARTY_UNVERIFIED',
  'THIRD_PARTY_VERIFIED',
  'AUTHORITATIVE_ISSUER',
  'CRYPTOGRAPHIC',
  'BIOMETRIC',
] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];

// ---- EvidenceRecord.method (§5.3) --------------------------------------
export const METHODS = [
  'SELF_DECLARED',
  'DOCUMENT',
  'API_REGISTRY',
  'SIGNATURE',
  'BIOMETRIC',
  'HUMAN_ATTESTED',
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
};
