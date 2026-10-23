// ATI-SEP-1 T2 (ADR-0036 Decision 4) — the ADMISSION FIELD CATALOGUE.
//
// Every field TI admits is listed here with its admission class:
//   Class A — shared professional evidence;
//   Class B — controlled identity and eligibility;
//   Class C — NEVER admitted (listed so the validator can name the refusal).
// The catalogue is enforced server-side by TI (validateTalentIngestRequest); the
// sender's own labels are never trusted. Documents are never admitted in any
// class — provenance may carry only an opaque `source_document_hash` (D-7).

export type AdmissionClass = 'A' | 'B';

/** Closed assertion-type vocabulary (the `Assertion.assertion_type` column). */
export const ASSERTION_TYPES = [
  // Class A
  'SKILL',
  'WORK_HISTORY',
  'EDUCATION',
  'CERTIFICATION',
  'PROJECT',
  'CURRENT_EMPLOYER',
  'TITLE',
  'LOCATION',
  'PUBLIC_PROFILE_URL',
  'AVAILABILITY',
  // Class B
  'NAME',
  'WORK_AUTHORIZATION',
  'VERIFICATION_OUTCOME',
] as const;
export type AssertionType = (typeof ASSERTION_TYPES)[number];

/** Assertion types a sender may put in `assertions[]` (NAME comes from `identity.names`). */
export const INGESTIBLE_ASSERTION_TYPES = ASSERTION_TYPES.filter((t) => t !== 'NAME') as readonly Exclude<
  AssertionType,
  'NAME'
>[];

export const ASSERTION_ADMISSION_CLASS: Readonly<Record<AssertionType, AdmissionClass>> = {
  SKILL: 'A',
  WORK_HISTORY: 'A',
  EDUCATION: 'A',
  CERTIFICATION: 'A',
  PROJECT: 'A',
  CURRENT_EMPLOYER: 'A',
  TITLE: 'A',
  LOCATION: 'A',
  PUBLIC_PROFILE_URL: 'A',
  AVAILABILITY: 'A',
  NAME: 'B',
  WORK_AUTHORIZATION: 'B',
  VERIFICATION_OUTCOME: 'B',
};

/** Identity-block fields (all Class B). */
export const IDENTITY_FIELD_ADMISSION_CLASS = {
  names: 'B',
  emails: 'B',
  phones: 'B',
  government_ids: 'B',
} as const satisfies Record<string, AdmissionClass>;

/**
 * The catalogue as data: one row per admitted field, with its class. Exposed so
 * the ATS publisher (and reviewers) read the same list TI enforces.
 */
export const ADMISSION_FIELD_CATALOGUE: ReadonlyArray<{
  field: string;
  admission_class: AdmissionClass;
  carried_as: 'assertion' | 'identity';
  note?: string;
}> = [
  { field: 'skills', admission_class: 'A', carried_as: 'assertion' },
  { field: 'work_history', admission_class: 'A', carried_as: 'assertion', note: 'includes accomplishments' },
  { field: 'education', admission_class: 'A', carried_as: 'assertion' },
  { field: 'certifications', admission_class: 'A', carried_as: 'assertion' },
  { field: 'projects', admission_class: 'A', carried_as: 'assertion' },
  { field: 'current_employer', admission_class: 'A', carried_as: 'assertion' },
  { field: 'title', admission_class: 'A', carried_as: 'assertion' },
  { field: 'location', admission_class: 'A', carried_as: 'assertion', note: 'city / region / country only' },
  { field: 'public_profile_urls', admission_class: 'A', carried_as: 'assertion' },
  { field: 'availability', admission_class: 'A', carried_as: 'assertion', note: 'status + date_available' },
  { field: 'names', admission_class: 'B', carried_as: 'identity', note: 'first / last / aliases' },
  { field: 'emails', admission_class: 'B', carried_as: 'identity' },
  { field: 'phones', admission_class: 'B', carried_as: 'identity' },
  { field: 'government_ids', admission_class: 'B', carried_as: 'identity', note: 'HMAC token only at rest' },
  {
    field: 'work_authorization',
    admission_class: 'B',
    carried_as: 'assertion',
    note: 'résumé-sourced values are non-authoritative (TI-1G)',
  },
  { field: 'verification_outcomes', admission_class: 'B', carried_as: 'assertion' },
];

/**
 * Class C — NEVER admitted. Matched against a normalized key (lowercase, only
 * [a-z0-9]) at any depth, wherever the key is not part of the closed schema.
 */
export const CLASS_C_EXACT_KEYS = [
  'notes',
  'note',
  'currentpay',
  'desiredpay',
  'pay',
  'salary',
  'compensation',
  'rate',
  'payrate',
  'billrate',
  'source',
  'leadsource',
  'ishot',
  'hot',
  'address',
  'address1',
  'address2',
  'streetaddress',
  'street',
  'zip',
  'zipcode',
  'postalcode',
  'postcode',
] as const;

/** Class C — any normalized key CONTAINING one of these is refused. */
export const CLASS_C_KEY_FRAGMENTS = [
  'requisition',
  'pipeline',
  'submittal',
  'interview',
  'joborder',
  'placement',
  'note',
  'salary',
  'compensation',
  'currentpay',
  'desiredpay',
] as const;

/** Source kinds (the `Assertion.source_kind` column). */
export const SOURCE_KINDS = ['RECRUITER', 'RESUME_DERIVED', 'TALENT_SELF', 'TI_ACQUIRED', 'VERIFICATION'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Source kinds a SENDER may claim. TI_ACQUIRED and VERIFICATION are TI-internal. */
export const INGEST_SOURCE_KINDS = ['RECRUITER', 'RESUME_DERIVED', 'TALENT_SELF'] as const;
export type IngestSourceKind = (typeof INGEST_SOURCE_KINDS)[number];

export const AVAILABILITY_STATUSES = ['AVAILABLE', 'NOT_AVAILABLE', 'OPEN_TO_OPPORTUNITIES'] as const;
export type AvailabilityStatus = (typeof AVAILABILITY_STATUSES)[number];

export const WORK_AUTHORIZATION_STATUSES = [
  'CITIZEN',
  'PERMANENT_RESIDENT',
  'AUTHORIZED',
  'REQUIRES_SPONSORSHIP',
  'NOT_AUTHORIZED',
  'UNKNOWN',
] as const;
export type WorkAuthorizationStatus = (typeof WORK_AUTHORIZATION_STATUSES)[number];

export const VERIFICATION_OUTCOME_TARGETS = ['EMAIL', 'PHONE', 'EMPLOYMENT', 'EDUCATION', 'CERTIFICATION'] as const;
export type VerificationOutcomeTarget = (typeof VERIFICATION_OUTCOME_TARGETS)[number];

export const VERIFICATION_OUTCOME_RESULTS = ['CONFIRMED', 'NOT_CONFIRMED'] as const;
export type VerificationOutcomeResult = (typeof VERIFICATION_OUTCOME_RESULTS)[number];

/** Identifier verification as reported by the sender (identity block). */
export const IDENTIFIER_VERIFICATION_STATUSES = ['VERIFIED', 'UNVERIFIED'] as const;
export type IdentifierVerificationStatus = (typeof IDENTIFIER_VERIFICATION_STATUSES)[number];
