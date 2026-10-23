// ATI-SEP-1 T1 — the closed vocabularies of the intelligence schema (String
// columns, documented in prisma/schema.prisma `///`, CHECK-constrained in the
// T1 migration). Enforced in code through these unions.

export const RESOLUTION_STATUSES = ['ACTIVE', 'PROVISIONAL', 'MERGED'] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const ACCESS_STATES = ['ACTIVE', 'AUDIT_RETAINED'] as const;
export type AccessState = (typeof ACCESS_STATES)[number];

export const IDENTIFIER_TYPES = ['EMAIL', 'PHONE', 'GOV_ID'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

export const IDENTIFIER_VERIFICATION = ['UNVERIFIED', 'VERIFIED', 'REVOKED'] as const;
export type IdentifierVerification = (typeof IDENTIFIER_VERIFICATION)[number];

export const IDENTIFIER_STATUSES = ['ACTIVE', 'SUPERSEDED'] as const;
export type IdentifierStatus = (typeof IDENTIFIER_STATUSES)[number];

export const REFERENCE_STATUSES = ['ACTIVE', 'ERASED', 'DETACHED'] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

export const ASSERTION_VERIFICATION = ['DECLARED', 'DOCUMENT_SUPPORTED', 'VERIFIED'] as const;
export type AssertionVerification = (typeof ASSERTION_VERIFICATION)[number];

export const ASSERTION_STATUSES = [
  'VALID',
  'STALE',
  'CONTRADICTED',
  'REVOKED',
  'SUPERSEDED',
  'DISPUTED',
  'WITHDRAWN',
] as const;
export type AssertionStatus = (typeof ASSERTION_STATUSES)[number];

/** Statuses after which an assertion no longer participates in a reference's snapshot. */
export const RETIRED_ASSERTION_STATUSES: readonly AssertionStatus[] = ['SUPERSEDED', 'WITHDRAWN', 'REVOKED'];

export const ASSERTION_EVENT_TYPES = [
  'ASSERTED',
  'SUPERSEDED',
  'STALE',
  'CONTRADICTED',
  'REVOKED',
  'DISPUTED',
  'WITHDRAWN',
  'REVALIDATED',
  'REPOINTED',
  // T10 — dispute and contradiction outcomes (DISPUTED → VALID / REVOKED; CONTRADICTED → VALID / REVOKED).
  'DISPUTE_RESOLVED',
  'CORRECTED',
  'CONTRADICTION_RESOLVED',
] as const;
export type AssertionEventType = (typeof ASSERTION_EVENT_TYPES)[number];

export const ASSERTION_LINK_TYPES = ['CORROBORATES', 'CONTRADICTS', 'SUPERSEDES', 'RECONCILES'] as const;
export type AssertionLinkType = (typeof ASSERTION_LINK_TYPES)[number];

export const IDENTITY_CONFLICT_TYPES = [
  'IDENTITY_ATTRIBUTE_CONFLICT',
  'ANCHOR_CONTRADICTION',
  'REFERENCE_IDENTITY_MUTATION',
] as const;
export type IdentityConflictType = (typeof IDENTITY_CONFLICT_TYPES)[number];

export const IDENTITY_CONFLICT_STATUSES = ['OPEN', 'RESOLVED'] as const;
export type IdentityConflictStatus = (typeof IDENTITY_CONFLICT_STATUSES)[number];

export const MERGE_SPLIT_KINDS = ['MERGE', 'SPLIT'] as const;
export type MergeSplitKind = (typeof MERGE_SPLIT_KINDS)[number];

export const INBOX_KINDS = ['TALENT_SNAPSHOT', 'TALENT_ERASED'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

// ── ATI-SEP-1 T4–T7 ──────────────────────────────────────────────────────────

export const READ_KINDS = ['PROFILE', 'EVIDENCE', 'ARTIFACTS'] as const;
export type ReadKind = (typeof READ_KINDS)[number];

export const READ_OUTCOMES = ['GRANTED', 'NOT_ENTITLED', 'SOURCE_SYSTEM_MISMATCH', 'REFERENCE_NOT_FOUND'] as const;
export type ReadOutcome = (typeof READ_OUTCOMES)[number];

/** Assertion statuses the projection reads (everything not retired). */
export const PROJECTED_ASSERTION_STATUSES: readonly AssertionStatus[] = ['VALID', 'STALE', 'CONTRADICTED', 'DISPUTED'];

/** Verification method / source recorded on a TI-verified identifier. */
export const EMAIL_OTP_METHOD = 'EMAIL_OTP';
export const SMS_OTP_METHOD = 'SMS_OTP';
export const PORTAL_VERIFICATION_SOURCE = 'aramo-portal';

// ── ATI-SEP-1 T10 — evidence lifecycle ───────────────────────────────────────

export const DISPUTE_EVENT_TYPES = [
  'OPENED',
  'STATEMENT_ADDED',
  'TRIAGED',
  'INFO_REQUESTED',
  'CORRECTED',
  'UPHELD',
  'WITHDRAWN',
  'EXTENDED',
  'NO_TRANSITION',
] as const;
export type DisputeEventType = (typeof DISPUTE_EVENT_TYPES)[number];

/** Source kinds TI itself originates (visible to every entitled tenant holding a reference). */
export const TI_ORIGINATED_SOURCE_KINDS: readonly string[] = ['VERIFICATION', 'TI_ACQUIRED'];
