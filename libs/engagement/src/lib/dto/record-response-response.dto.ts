import type { TalentSelectionEventView as TalentEngagementEventView } from '@aramo/selection';
import type { TalentSelectionView as TalentJobEngagementView } from '@aramo/selection';

// M5 PR-7 §4.2 — HTTP response DTO for POST /v1/selections/{id}/response.
//
// Response shape per directive §4.1 step 7:
//   - engagement: updated TalentJobEngagement view (state column
//     advanced from 'awaiting_response' to 'responded').
//   - response_event: the appended `response_received`
//     TalentEngagementEvent view. Its event_payload conforms to
//     EngagementResponseReceivedPayload.
//
// The paired state_transition event row (awaiting_response → responded)
// is NOT projected on this response — mirrors the PR-6
// OutreachSendResponseDto convention of returning only the primary
// event. Readers fetch it via GET /v1/selections/{id}/events.
export interface RecordResponseResponseDto {
  engagement: TalentJobEngagementView;
  response_event: TalentEngagementEventView;
}
