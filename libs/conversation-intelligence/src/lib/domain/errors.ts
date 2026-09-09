// CI-B6 — lib-local domain errors + safe error taxonomy (no shared error-code
// registry entry — B6 exposes no client HTTP surface). Every code is a stable
// safe token; NONE ever carries transcript text or a raw model response.

import type { ConversationIntelligenceRunStatus } from './run-enums.js';

/** Stable safe taxonomy tokens persisted to `last_error_code`. */
export const CI_PROCESSING_ERROR_CODES = {
  AI_PROCESSING_NOT_AUTHORIZED: 'AI_PROCESSING_NOT_AUTHORIZED',
  TALENT_ASSOCIATION_MISSING: 'TALENT_ASSOCIATION_MISSING',
  TALENT_ASSOCIATION_AMBIGUOUS: 'TALENT_ASSOCIATION_AMBIGUOUS',
  NORMALIZED_TRANSCRIPT_NOT_READY: 'NORMALIZED_TRANSCRIPT_NOT_READY',
  NORMALIZED_ARTIFACT_NOT_FOUND: 'NORMALIZED_ARTIFACT_NOT_FOUND',
  NORMALIZED_HASH_MISMATCH: 'NORMALIZED_HASH_MISMATCH',
  REQUISITION_SNAPSHOT_NOT_FOUND: 'REQUISITION_SNAPSHOT_NOT_FOUND',
  MODEL_PROVIDER_UNAVAILABLE: 'MODEL_PROVIDER_UNAVAILABLE',
  MODEL_RATE_LIMITED: 'MODEL_RATE_LIMITED',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
  MODEL_OUTPUT_SCHEMA_MISMATCH: 'MODEL_OUTPUT_SCHEMA_MISMATCH',
  CITATION_INVALID: 'CITATION_INVALID',
  CITATION_SPAN_MISMATCH: 'CITATION_SPAN_MISMATCH',
  PROCESSING_RETRY_EXHAUSTED: 'PROCESSING_RETRY_EXHAUSTED',
} as const;

export type CiProcessingErrorCode =
  (typeof CI_PROCESSING_ERROR_CODES)[keyof typeof CI_PROCESSING_ERROR_CODES];

/** Illegal processing-run state transition. */
export class CiRunInvalidStateError extends Error {
  readonly from: ConversationIntelligenceRunStatus;
  readonly to: ConversationIntelligenceRunStatus;
  constructor(from: ConversationIntelligenceRunStatus, to: ConversationIntelligenceRunStatus) {
    super(`Illegal CI run transition: ${from} -> ${to}`);
    this.name = 'CiRunInvalidStateError';
    this.from = from;
    this.to = to;
  }
}

/**
 * A structured-output / citation validation failure. Carries a SAFE code +
 * structural detail only (index/field/taxonomy) — never model or transcript
 * content (directive §output-privacy).
 */
export class CiAnalysisValidationError extends Error {
  readonly code: CiProcessingErrorCode;
  constructor(code: CiProcessingErrorCode, detail: string) {
    super(`CI analysis validation failed [${code}]: ${detail}`);
    this.name = 'CiAnalysisValidationError';
    this.code = code;
  }
}

/** The referenced run does not exist within the tenant (tenant-safe). */
export class CiRunNotFoundError extends Error {
  constructor() {
    super('ConversationIntelligenceRun not found in tenant');
    this.name = 'CiRunNotFoundError';
  }
}
