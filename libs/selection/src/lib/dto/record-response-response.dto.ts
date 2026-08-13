import type { TalentSelectionEventView } from './talent-selection-event.view.js';
import type { TalentSelectionView } from './talent-selection.view.js';

// M5 PR-7 §4.2 — HTTP response DTO for POST /v1/selections/{id}/response.
//
// Response shape per directive §4.1 step 7:
//   - selection: updated TalentSelection view (state column
//     advanced from 'awaiting_response' to 'responded').
//   - response_event: the appended `response_received`
//     TalentSelectionEvent view. Its event_payload conforms to
//     SelectionResponseReceivedPayload.
//
// The paired state_transition event row (awaiting_response → responded)
// is NOT projected on this response — mirrors the PR-6
// OutreachSendResponseDto convention of returning only the primary
// event. Readers fetch it via GET /v1/selections/{id}/events.
export interface RecordResponseResponseDto {
  selection: TalentSelectionView;
  response_event: TalentSelectionEventView;
}
