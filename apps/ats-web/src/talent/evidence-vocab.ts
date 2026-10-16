// Display labels for the evidence-ledger / identity vocabularies the Trust panel and the
// Sourcing subject drawer render. Hand-mirrored from libs/talent-trust/src/lib/vocab.ts
// (SEED_ASSERTION_TYPES + ANCHOR_KINDS, EVIDENCE_STATUSES, SOURCE_CLASSES, METHODS,
// EVIDENCE_EVENT_TYPES, RESOLUTION_SUBJECT_REF_TYPES) and the dossier VerificationStateItem
// status — ats-web must not import the scope:cip talent-trust lib (the I15 CIP⊥ATS wall).
// assertion_type is extensible on the BE, so an unregistered type degrades to sentence case.
import { codeLabel } from '../ui/code-label';

export const EVIDENCE_ASSERTION_TYPE_LABELS: Readonly<Record<string, string>> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
  FULL_NAME: 'Full name',
  PROFILE_URL: 'External profile',
  PHONE_VERIFIED: 'Phone verified',
  SKILL: 'Skill',
  EMPLOYMENT: 'Employment',
  DEGREE: 'Degree',
  CERTIFICATION: 'Certification',
  FACE_MATCH: 'Face match',
  LIVENESS: 'Liveness check',
  RIGHT_TO_WORK: 'Right to work',
  IDENTITY_DOCUMENT: 'Identity document',
  EMAIL_CONTROL_VERIFIED: 'Email control verified',
  PHONE_CONTROL_VERIFIED: 'Phone control verified',
  TIMELINE_GAP: 'Timeline gap',
  SCREENING_FINDING: 'Screening finding',
  ATTESTATION: 'Attestation',
  LONGITUDINAL_PRESENCE: 'Presence over time',
  HISTORY_SPAN: 'History span',
  GOVERNMENT_ID: 'Government ID',
};
export function evidenceAssertionTypeLabel(code: string): string {
  return codeLabel(EVIDENCE_ASSERTION_TYPE_LABELS, code);
}

export const EVIDENCE_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'Pending',
  VALID: 'Valid',
  STALE: 'Stale',
  CONTRADICTED: 'Contradicted',
  REVOKED: 'Revoked',
  SUPERSEDED: 'Superseded',
  DISPUTED: 'Disputed',
};
export function evidenceStatusLabel(code: string): string {
  return codeLabel(EVIDENCE_STATUS_LABELS, code);
}

export const EVIDENCE_SOURCE_CLASS_LABELS: Readonly<Record<string, string>> = {
  SELF: 'Self-stated',
  THIRD_PARTY_UNVERIFIED: 'Third party (unverified)',
  THIRD_PARTY_VERIFIED: 'Third party (verified)',
  PLATFORM_VERIFIED: 'Platform verified',
  AUTHORITATIVE_ISSUER: 'Authoritative issuer',
  CRYPTOGRAPHIC: 'Cryptographic',
  BIOMETRIC: 'Biometric',
};
export function evidenceSourceClassLabel(code: string): string {
  return codeLabel(EVIDENCE_SOURCE_CLASS_LABELS, code);
}

export const EVIDENCE_METHOD_LABELS: Readonly<Record<string, string>> = {
  SELF_DECLARED: 'Self-declared',
  DOCUMENT: 'Document',
  API_REGISTRY: 'Registry lookup',
  SIGNATURE: 'Signature',
  BIOMETRIC: 'Biometric',
  HUMAN_ATTESTED: 'Human attested',
  CONTROL_ROUND_TRIP: 'Control round-trip',
  DERIVED: 'Derived',
};
export function evidenceMethodLabel(code: string): string {
  return codeLabel(EVIDENCE_METHOD_LABELS, code);
}

export const EVIDENCE_EVENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  CREATED: 'Recorded',
  VALIDATED: 'Validated',
  MARKED_STALE: 'Marked stale',
  CONTRADICTED: 'Contradicted',
  REVOKED: 'Revoked',
  SUPERSEDED: 'Superseded',
  DISPUTED: 'Disputed',
  DISPUTE_RESOLVED: 'Dispute resolved',
  CONTRADICTION_RESOLVED: 'Contradiction resolved',
};
export function evidenceEventTypeLabel(code: string): string {
  return codeLabel(EVIDENCE_EVENT_TYPE_LABELS, code);
}

// SubjectAnchor.anchor_kind (the verification rows on the Trust panel).
export const ANCHOR_KIND_LABELS: Readonly<Record<string, string>> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
};
export function anchorKindLabel(code: string): string {
  return codeLabel(ANCHOR_KIND_LABELS, code);
}

// Dossier VerificationStateItem.status.
export const VERIFICATION_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  EXPIRED: 'Expired',
  NONE: 'Not verified',
};
export function verificationStatusLabel(code: string): string {
  return codeLabel(VERIFICATION_STATUS_LABELS, code);
}

// Identity reference type on a resolution subject.
export const IDENTITY_REF_TYPE_LABELS: Readonly<Record<string, string>> = {
  SOURCED_TALENT: 'Sourced talent',
  PERSON_CLUSTER: 'Person cluster',
  ATS_TALENT_RECORD: 'Talent record',
  ANCHOR: 'Contact detail',
};
export function identityRefTypeLabel(code: string): string {
  return codeLabel(IDENTITY_REF_TYPE_LABELS, code);
}
