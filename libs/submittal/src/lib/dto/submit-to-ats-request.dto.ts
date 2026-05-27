import { Allow } from 'class-validator';

import type { TalentSubmittalEventView } from './talent-submittal-event.view.js';
import type { TalentSubmittalRecordView } from './talent-submittal-record.view.js';

// M5 PR-8b2 §4.6 — HTTP request/response DTOs for POST
// /v1/submittals/{submittal_id}/submit-to-ats.
//
// Fires the canonical mainline transition ready_for_review ->
// submitted_to_ats (mainline transition 3). Per Ruling 6 this is the
// transition that populates confirmed_at NULL -> non-NULL (preserving
// the M4 confirmed_at column semantic post-rename; M4's
// 'draft -> submitted with confirmed_at' now reads as
// 'ready_for_review -> submitted_to_ats with confirmed_at').
//
// Per Ruling 13 the request body is empty. The `@Allow()` field
// registers the class with class-validator metadata so the global
// ValidationPipe (whitelist + forbidNonWhitelisted) doesn't reject
// the empty payload at transform time (class-validator >= 0.14
// defaults to forbidUnknownValues: true for unregistered classes).
// Per Ruling 14 response wraps { submittal, event }.

export class SubmitToAtsRequestDto {
  @Allow()
  _?: never;
}

export interface SubmitToAtsResponseDto {
  submittal: TalentSubmittalRecordView;
  event: TalentSubmittalEventView;
}
