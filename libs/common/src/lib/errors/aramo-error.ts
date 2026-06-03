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
