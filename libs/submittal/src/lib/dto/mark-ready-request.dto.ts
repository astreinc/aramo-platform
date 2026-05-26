import type { TalentSubmittalEventView } from './talent-submittal-event.view.js';
import type { TalentSubmittalRecordView } from './talent-submittal-record.view.js';

// M5 PR-8b2 §4.6 — HTTP request/response DTOs for POST
// /v1/submittals/{submittal_id}/mark-ready.
//
// Fires the canonical mainline transition handoff_draft -> ready_for_review
// (mainline transition 2). Per Ruling 13 the request body is empty;
// the URL identifies the action and the path parameter identifies the
// resource. Body validation (class-validator on an empty class) returns
// 400 VALIDATION_ERROR on unexpected payload shapes.
//
// Response shape per Ruling 14: { submittal, event } -- the updated
// TalentSubmittalRecord projection alongside the freshly appended
// TalentSubmittalEvent (state_transition; payload {from_state,to_state}
// per Ruling 16 minimum-viable shape; mirrors M5 PR-3 engagement
// transitionState response shape).

export class MarkReadyRequestDto {}

export interface MarkReadyResponseDto {
  submittal: TalentSubmittalRecordView;
  event: TalentSubmittalEventView;
}
