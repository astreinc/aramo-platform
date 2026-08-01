import type { RedactionReasonCode } from './redaction-reason.js';

// POST /v1/activities/:id/redact payload. BOTH fields are mandatory (R2) — a
// redaction with no stated reason is indistinguishable from a cover-up, and the
// reason is the entire justification for preferring redaction over deletion.
// `redaction_reason_code` must be a member of the §3 closed vocabulary.
export interface RedactActivityRequestDto {
  redaction_reason_code: RedactionReasonCode;
  redaction_reason: string;
}
