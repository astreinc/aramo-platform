import type { TalentSelectionEventView } from './talent-selection-event.view.js';
import type { TalentSelectionView } from './talent-selection.view.js';

// M5 PR-8a §4.2 — HTTP response DTO for POST /v1/selections/{id}/conversation.
//
// Response shape per directive §4.1 step 7:
//   - selection: updated TalentSelection view (state column
//     advanced from 'responded' to 'in_conversation').
//   - conversation_event: the appended `conversation_started`
//     TalentSelectionEvent view. Its event_payload conforms to
//     SelectionConversationStartedPayload.
//
// The paired state_transition event row (responded → in_conversation)
// is NOT projected on this response — mirrors the PR-6
// OutreachSendResponseDto + PR-7 RecordResponseResponseDto convention
// of returning only the primary event. Readers fetch it via GET
// /v1/selections/{id}/events.
export interface RecordConversationStartedResponseDto {
  selection: TalentSelectionView;
  conversation_event: TalentSelectionEventView;
}
