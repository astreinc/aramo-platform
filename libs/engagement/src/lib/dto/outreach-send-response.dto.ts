import type { TalentEngagementEventView } from './talent-engagement-event.view.js';
import type { TalentJobEngagementView } from './talent-job-engagement.view.js';

// M5 PR-6 §4.2 — HTTP response DTO for POST /v1/engagements/{id}/outreach.
//
// Response shape per directive §4.1 step 9:
//   - engagement: the updated TalentJobEngagement view (state column
//     advanced from 'engaged' to 'awaiting_response').
//   - outreach_event: the appended `outreach_sent` TalentEngagementEvent
//     view. Its event_payload conforms to OutreachSentPayload.
//   - delivery_id: the synthetic delivery identifier emitted by the
//     DeliveryProvider (SendStubDeliveryProvider at PR-6).
//
// The state_transition event row (engaged → awaiting_response) is NOT
// projected on this response — readers can fetch it via
// GET /v1/engagements/{id}/events (which already exists at PR-4).

export interface OutreachSendResponseDto {
  engagement: TalentJobEngagementView;
  outreach_event: TalentEngagementEventView;
  delivery_id: string;
}
