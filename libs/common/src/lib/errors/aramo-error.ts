import type { ErrorCode } from './error-codes.js';

export interface AramoErrorContext {
  requestId: string;
  details?: Record<string, unknown>;
  displayMessage?: string;
  logMessage?: string;
}

// Canonical HTTP-status mapping for each registered ErrorCode.
//
// Per M4 PR-2 directive §4.3: SUBMITTAL_STRETCH_BLOCKED maps to HTTP 422.
// The mapping is exhaustive over ERROR_CODES (TypeScript enforces this via
// the `Record<ErrorCode, number>` constraint — a missing entry is a build
// error). Existing call sites still pass `statusCode` at construction time
// for backwards compatibility; this constant records the canonical pairing
// each directive that introduced the code chose.
export const ERROR_CODE_TO_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = {
  AUTH_REQUIRED: 401,
  INVALID_TOKEN: 401,
  TENANT_ACCESS_DENIED: 403,
  VALIDATION_ERROR: 400,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  INTERNAL_ERROR: 500,
  INVALID_SCOPE_COMBINATION: 422,
  TENANT_SELECTION_REQUIRED: 409,
  REFRESH_TOKEN_INVALID: 401,
  INVALID_REQUEST: 400,
  INSUFFICIENT_PERMISSIONS: 403,
  NOT_FOUND: 404,
  SUBMITTAL_STRETCH_BLOCKED: 422,
  JUSTIFICATION_REQUIRED: 422,
  ATTESTATION_MISSING: 422,
  EXAMINATION_PINNED_OUTDATED: 409,
  SUBMITTAL_ALREADY_CONFIRMED: 409,
  OVERRIDE_INVALID: 422,
  REVOKE_NOT_ALLOWED: 422,
  ENGAGEMENT_EVENT_REF_NOT_FOUND: 422,
  ENGAGEMENT_REFERENCE_NOT_FOUND: 422,
  ENGAGEMENT_STATE_INVALID: 422,
  AI_PROVIDER_UNAVAILABLE: 502,
  AI_RATE_LIMITED: 429,
  SUBMITTAL_STATE_INVALID: 422,
  CONSENT_NOT_GRANTED_AT_SEND: 403,
  TENANT_CAPABILITY_NOT_ENTITLED: 403,
  INVALID_PIPELINE_TRANSITION: 422,
  REQUISITION_NO_OPENINGS: 409,
  TALENT_LINK_INVALID: 422,
  SAVED_LIST_ITEM_TYPE_MISMATCH: 422,
  IMPORT_THRESHOLD_EXCEEDED: 422,
  IMPORT_ALREADY_REVERTED: 409,
  IMPORT_REVERT_WINDOW_EXPIRED: 409,
  CANONICALIZATION_PAYLOAD_NOT_FOUND: 404,
  OBJECT_STORAGE_UPLOAD_FAILED: 502,
  PRESIGNED_URL_EXPIRED: 410,
  TENANT_ALREADY_EXISTS: 409,
  COGNITO_PROVISION_FAILED: 502,
  INVITATION_ALREADY_EXISTS: 409,
  MANAGEMENT_CYCLE_REJECTED: 409,
  TALENT_RECORD_SUPERSEDED: 422,
  // TR-6 B2 — advisory-resolution domain codes (see error-codes.ts).
  ADVISORY_NOT_PENDING: 409,
  ADVISORY_NOT_MERGED: 409,
  ADVISORY_NO_MERGED_SUBJECT: 409,
  MERGE_SUBJECT_NOT_ACTIVE: 409,
  CONTRADICTION_OVERRIDE_REQUIRED: 400,
  REVERSAL_JUSTIFICATION_REQUIRED: 400,
  // TR-3 B2 — email-verification request consent gate (denied OR empty-ledger).
  VERIFICATION_CONSENT_REQUIRED: 403,
  // TR-4 B1 — registered assertion_type written with a non-canonical payload.
  CLAIM_SHAPE_INVALID: 422,
  // TR-4 B3 — resolveContradiction on a non-CONTRADICTED record.
  EVIDENCE_NOT_CONTRADICTED: 422,
  // Platform-Console Increment-2 PR-1 — tenant lifecycle mint-gate denials (403).
  TENANT_SUSPENDED: 403,
  TENANT_CLOSED: 403,
  // TR-12 B1 — dismissProposal on a non-OPEN proposal (already terminal).
  PROPOSAL_NOT_OPEN: 409,
  // TR-15 B1 — the dispute machinery's operational refusals (all 422).
  EVIDENCE_NOT_DISPUTABLE: 422,
  EVIDENCE_NOT_DISPUTED: 422,
  DISPUTE_OUTCOME_INVALID: 422,
};

// Base error class. Thrown anywhere in the app where a structured response
// is required; converted to the locked Phase 5 envelope by AramoExceptionFilter.
export class AramoError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly context: AramoErrorContext;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    context: AramoErrorContext,
  ) {
    super(message);
    this.name = 'AramoError';
    this.code = code;
    this.statusCode = statusCode;
    this.context = context;
  }
}
