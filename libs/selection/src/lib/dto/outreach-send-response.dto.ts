import type { TalentSelectionEventView } from './talent-selection-event.view.js';
import type { TalentSelectionView } from './talent-selection.view.js';

// M5 PR-6 §4.2 — HTTP response DTO for POST /v1/selections/{id}/outreach.
//
// Response shape per directive §4.1 step 9:
//   - selection: the updated TalentSelection view (state column
//     advanced from 'engaged' to 'awaiting_response').
//   - outreach_event: the appended `outreach_sent` TalentSelectionEvent
//     view. Its event_payload conforms to OutreachSentPayload.
//   - delivery_id: the synthetic delivery identifier emitted by the
//     DeliveryProvider (SendStubDeliveryProvider at PR-6).
//
// The state_transition event row (engaged → awaiting_response) is NOT
// projected on this response — readers can fetch it via
// GET /v1/selections/{id}/events (which already exists at PR-4).

export interface OutreachSendResponseDto {
  selection: TalentSelectionView;
  outreach_event: TalentSelectionEventView;
  delivery_id: string;
}
