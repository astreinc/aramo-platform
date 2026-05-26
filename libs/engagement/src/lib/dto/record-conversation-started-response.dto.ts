import type { TalentEngagementEventView } from './talent-engagement-event.view.js';
import type { TalentJobEngagementView } from './talent-job-engagement.view.js';

// M5 PR-8a §4.2 — HTTP response DTO for POST /v1/engagements/{id}/conversation.
//
// Response shape per directive §4.1 step 7:
//   - engagement: updated TalentJobEngagement view (state column
//     advanced from 'responded' to 'in_conversation').
//   - conversation_event: the appended `conversation_started`
//     TalentEngagementEvent view. Its event_payload conforms to
//     EngagementConversationStartedPayload.
//
// The paired state_transition event row (responded → in_conversation)
// is NOT projected on this response — mirrors the PR-6
// OutreachSendResponseDto + PR-7 RecordResponseResponseDto convention
// of returning only the primary event. Readers fetch it via GET
// /v1/engagements/{id}/events.
export interface RecordConversationStartedResponseDto {
  engagement: TalentJobEngagementView;
  conversation_event: TalentEngagementEventView;
}
