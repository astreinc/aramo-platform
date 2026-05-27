import { Allow } from 'class-validator';

import type { TalentSubmittalEventView } from './talent-submittal-event.view.js';
import type { TalentSubmittalRecordView } from './talent-submittal-record.view.js';

// M5 PR-8b2 §4.6 — HTTP request/response DTOs for POST
// /v1/submittals/{submittal_id}/mark-ready.
//
// Fires the canonical mainline transition handoff_draft -> ready_for_review
// (mainline transition 2). Per Ruling 13 the request body is empty;
// the URL identifies the action and the path parameter identifies the
// resource.
//
// The `@Allow()` field-decorator below registers the empty DTO class
// with class-validator's metadata storage. Without it, the global
// ValidationPipe at apps/api/src/main.ts (whitelist: true,
// forbidNonWhitelisted: true) treats the empty class as having
// "unknown values" per class-validator >= 0.14's
// `forbidUnknownValues: true` default — the body request hangs at the
// transform pipe and never reaches the controller. The placeholder
// field is optional + accepts any value so empty `{}` bodies pass
// through cleanly.
//
// Response shape per Ruling 14: { submittal, event } -- the updated
// TalentSubmittalRecord projection alongside the freshly appended
// TalentSubmittalEvent (state_transition; payload {from_state,to_state}
// per Ruling 16 minimum-viable shape; mirrors M5 PR-3 engagement
// transitionState response shape).

export class MarkReadyRequestDto {
  @Allow()
  _?: never;
}

export interface MarkReadyResponseDto {
  submittal: TalentSubmittalRecordView;
  event: TalentSubmittalEventView;
}
