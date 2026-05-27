import { Allow } from 'class-validator';

import type { TalentSubmittalEventView } from './talent-submittal-event.view.js';
import type { TalentSubmittalRecordView } from './talent-submittal-record.view.js';

// M5 PR-8b2 §4.6 — HTTP request/response DTOs for POST
// /v1/submittals/{submittal_id}/confirm-ats.
//
// Fires the canonical mainline transition submitted_to_ats -> confirmed
// (mainline transition 4; lifecycle terminal). `confirmed` is a fully
// terminal state -- no outgoing transitions (Ruling 5: not even sibling-
// revoke applies once ATS confirms).
//
// Per Ruling 13 the request body is empty. The `@Allow()` field
// registers the class with class-validator metadata so the global
// ValidationPipe (whitelist + forbidNonWhitelisted) doesn't reject
// the empty payload at transform time (class-validator >= 0.14
// defaults to forbidUnknownValues: true for unregistered classes).
// ATS external reference id on /confirm-ats body is explicitly
// OUT-OF-SCOPE per directive §5 (deferred to future consumer PR).
// Per Ruling 14 response wraps { submittal, event }.

export class ConfirmAtsRequestDto {
  @Allow()
  _?: never;
}

export interface ConfirmAtsResponseDto {
  submittal: TalentSubmittalRecordView;
  event: TalentSubmittalEventView;
}
