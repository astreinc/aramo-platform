// M5 PR-5 Ruling 5 — typed AiDraftEvent payload interfaces, one per
// closed-list event_type. Closed list of 5 event types:
//   - request_built: input-side observability (post-redaction snapshot).
//   - request_sent: marks the provider call boundary + retry attempt.
//   - response_received: output-side observability + token accounting.
//   - redaction_applied: PII redaction summary (pre_prompt | post_completion).
//   - error_raised: error path (provider / secret-cache / validation).
//
// Per ADR-0015 Decision 5: raw prompt / completion text is NOT
// persisted. Only sha256 hashes and structured metadata.

export interface RequestBuiltPayload {
  model: string;
  prompt_sha256: string;
  prompt_token_estimate: number;
  max_tokens: number;
  redacted_span_count_input: number;
}

export interface RequestSentPayload {
  model: string;
  retry_attempt: number;
}

export interface ResponseReceivedPayload {
  model_used: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  completion_sha256: string;
  redacted_span_count_output: number;
}

export interface RedactionAppliedPayload {
  kind: 'pre_prompt' | 'post_completion';
  count: number;
  hashed_input_ref: string;
}

export interface ErrorRaisedPayload {
  stage: 'request_built' | 'request_sent' | 'response_received' | 'redaction';
  error_code: string;
  kind?: string;
  message: string;
}

export const AI_DRAFT_EVENT_TYPES = [
  'request_built',
  'request_sent',
  'response_received',
  'redaction_applied',
  'error_raised',
] as const;

export type AiDraftEventType = (typeof AI_DRAFT_EVENT_TYPES)[number];

export const ARAMO_AI_DRAFT_MODEL = 'claude-sonnet-4-6';
