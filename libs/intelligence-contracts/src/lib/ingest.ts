import type {
  AvailabilityStatus,
  IdentifierVerificationStatus,
  IngestSourceKind,
  VerificationOutcomeResult,
  VerificationOutcomeTarget,
  WorkAuthorizationStatus,
} from './admission.js';
import type { SourceSystemId } from './events.js';

// ATI-SEP-1 T2 (ADR-0036 Decision 3/4) — POST /v1/ingest/talent and
// POST /v1/ingest/talent/erased wire shapes. The schema is CLOSED: any key not
// declared here is refused (validateTalentIngestRequest). The payload is a FULL
// SNAPSHOT of what one source reference asserts: an assertion previously sent by
// the same reference and absent from a later snapshot is superseded.

export interface IdentifierVerification {
  status: IdentifierVerificationStatus;
  /** Required when status = VERIFIED (e.g. EMAIL_OTP, SMS_OTP). */
  method?: string;
  /** Who performed the verification (e.g. ARAMO_PORTAL). Required when VERIFIED. */
  source?: string;
  /** ISO-8601 instant. Required when VERIFIED. */
  verified_at?: string;
}

export interface IdentityEmail {
  value: string;
  is_primary: boolean;
  verification?: IdentifierVerification;
}

export interface IdentityPhone {
  value: string;
  is_primary: boolean;
  verification?: IdentifierVerification;
}

/** Raw in transit ONLY — TI stores a keyed HMAC token, never the value. */
export interface IdentityGovernmentId {
  value: string;
  jurisdiction: string;
  identifier_class: string;
  verification?: IdentifierVerification;
}

export interface IdentityNames {
  first?: string;
  last?: string;
  aliases?: string[];
}

export interface TalentIngestIdentity {
  names?: IdentityNames;
  emails?: IdentityEmail[];
  phones?: IdentityPhone[];
  government_ids?: IdentityGovernmentId[];
}

export interface IngestLocation {
  city?: string;
  region?: string;
  country?: string;
}

/** Payload shape per assertion type (closed — every key listed). */
export interface AssertionPayloads {
  SKILL: { name: string; years?: number; last_used?: string; proficiency?: string };
  WORK_HISTORY: {
    employer: string;
    title?: string;
    start_date?: string;
    end_date?: string;
    is_current?: boolean;
    location?: IngestLocation;
    summary?: string;
    accomplishments?: string[];
  };
  EDUCATION: {
    institution: string;
    degree?: string;
    field_of_study?: string;
    start_date?: string;
    end_date?: string;
    completed?: boolean;
  };
  CERTIFICATION: { name: string; issuer?: string; issued_on?: string; expires_on?: string; credential_id?: string };
  PROJECT: { name: string; summary?: string; role?: string; start_date?: string; end_date?: string };
  CURRENT_EMPLOYER: { name: string };
  TITLE: { value: string };
  LOCATION: IngestLocation;
  PUBLIC_PROFILE_URL: { url: string; label?: string };
  AVAILABILITY: { status: AvailabilityStatus; date_available?: string };
  WORK_AUTHORIZATION: { status: WorkAuthorizationStatus; jurisdiction?: string };
  VERIFICATION_OUTCOME: {
    target: VerificationOutcomeTarget;
    result: VerificationOutcomeResult;
    method: string;
    verified_at: string;
  };
}

export type IngestAssertionType = keyof AssertionPayloads;

export interface IngestAssertionProvenance {
  /** Opaque sha256 hex of the source document. The ONLY document trace admitted (D-7). */
  source_document_hash?: string;
}

export type TalentIngestAssertion = {
  [K in IngestAssertionType]: {
    assertion_type: K;
    payload: AssertionPayloads[K];
    source_kind: IngestSourceKind;
    observed_at: string;
    valid_from?: string;
    valid_to?: string;
    ai_derived?: boolean;
    provenance?: IngestAssertionProvenance;
  };
}[IngestAssertionType];

export interface TalentIngestRequest {
  source_system_id: SourceSystemId;
  source_tenant_id: string;
  external_talent_id: string;
  source_event_id: string;
  occurred_at: string;
  identity: TalentIngestIdentity;
  assertions: TalentIngestAssertion[];
}

/** @deprecated T0 placeholder name — use TalentIngestRequest. */
export type TalentIngestionRequest = TalentIngestRequest;

export interface TalentErasedRequest {
  source_system_id: SourceSystemId;
  source_tenant_id: string;
  external_talent_id: string;
  source_event_id: string;
  occurred_at: string;
}

export const INGEST_OUTCOMES = ['CREATED', 'LINKED', 'UPDATED'] as const;
export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

export const RESOLUTION_RULES = [
  'EXISTING_REFERENCE',
  'VERIFIED_ANCHOR',
  'NEW_PROVISIONAL',
  'ANCHOR_CONTRADICTION',
] as const;
export type ResolutionRule = (typeof RESOLUTION_RULES)[number];

export interface TalentIngestResponse {
  intelligence_subject_id: string;
  outcome: IngestOutcome;
  resolution: ResolutionRule;
  changed: boolean;
  assertions_added: number;
  assertions_superseded: number;
  conflicts_opened: number;
  /** true when this response is the stored outcome of an already-processed event. */
  replayed: boolean;
}

/** @deprecated T0 placeholder name — use TalentIngestResponse. */
export type TalentIngestionResponse = TalentIngestResponse;

export interface TalentErasedResponse {
  outcome: 'ERASED' | 'ALREADY_ERASED' | 'NOT_FOUND';
  intelligence_subject_id: string | null;
  subject_access_state: 'ACTIVE' | 'AUDIT_RETAINED' | null;
  replayed: boolean;
}

/** Refusal codes returned (400) by the ingestion endpoints. */
export const INGEST_REJECTION_CODES = ['DOCUMENT_REJECTED', 'CLASS_C_REJECTED', 'INVALID_REQUEST'] as const;
export type IngestRejectionCode = (typeof INGEST_REJECTION_CODES)[number];

export interface IngestValidationIssue {
  /** JSON path, e.g. `$.assertions[2].payload.name`. */
  path: string;
  code: IngestRejectionCode | 'UNKNOWN_KEY' | 'MISSING' | 'TYPE' | 'VALUE';
  message: string;
}

export type IngestValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: IngestRejectionCode; issues: IngestValidationIssue[] };

/** POST /v1/oauth/token (client_credentials) response. */
export interface ServiceTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

/** Scope required by the ingestion endpoints. */
export const INTELLIGENCE_INGEST_SCOPE = 'intelligence:ingest' as const;
