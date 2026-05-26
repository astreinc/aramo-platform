// M5 PR-8b1 §4.5 — AppendSubmittalEventInput.
//
// Repository input shape for TalentSubmittalEventRepository.appendEvent.
// Mirrors libs/engagement/src/lib/engagement-event.repository.ts
// AppendEventInput with engagement_id -> submittal_id substitution.
//
// Defensive `Submittal` prefix per Lead-Q-PR-8b1-A7 (parity with
// `TalentSubmittal*` naming) and Process Lesson 53 (workspace-unique
// type-name discipline; engagement-side `AppendEventInput` is
// unqualified, but submittal-side adopts the qualified prefix at
// PR-8b1 introduction to avoid a future collision risk if the
// engagement-side type is ever surfaced cross-lib).

import type { SubmittalEventTypeValue } from './talent-submittal-event.view.js';

export interface AppendSubmittalEventInput {
  id: string;
  tenant_id: string;
  submittal_id: string;
  event_type: SubmittalEventTypeValue;
  event_payload: unknown;
}
