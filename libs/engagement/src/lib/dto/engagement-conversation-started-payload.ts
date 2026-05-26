// M5 PR-8a §4.2 — typed event_payload shape for TalentEngagementEvent
// rows of event_type='conversation_started' (Ruling 2 + 3).
//
// Name defensively prefixed `Engagement` per Ruling 2 + Process Lesson
// 53: avoids type-name collision with any future cross-domain
// `ConversationStartedPayload` (e.g. a hypothetical libs/conversation
// or libs/messaging consumer). Mirrors the PR-7
// EngagementResponseReceivedPayload naming discipline.
//
// Minimum-viable closed-list field set per Ruling 3 (deferral of
// conversation_channel / first_message_excerpt_sha256 /
// conversation_thread_id to future PRs unless directive amendment
// mandates):
//   - conversation_started_at: ISO-8601 timestamp the recruiter began
//     the in-bound conversation with the talent. Distinct from the
//     event row's created_at.
//   - recorded_by_user_id: which recruiter recorded the conversation —
//     derived from authContext.sub at the controller boundary.
//
// NO cross-event reference field (Ruling 3 — workflow invariant is
// enforced by canTransition: responded → in_conversation is the only
// legal transition out of 'responded'). The prior response_received
// event is implicit; no outreach_event_ref_id / response_event_ref_id
// is required.
//
// Stored as Postgres jsonb in event_payload. TalentEngagementEventView
// types event_payload as `unknown`; consumers narrow at the consumption
// site (M5 PR-2 design).

export interface EngagementConversationStartedPayload {
  conversation_started_at: string;
  recorded_by_user_id: string;
}
