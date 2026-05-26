// M5 PR-7 §4.2 — typed event_payload shape for TalentEngagementEvent
// rows of event_type='response_received' (Ruling 2 + 3).
//
// Name defensively prefixed `Engagement` per Ruling 2: avoids type-
// name collision with libs/ai-draft's internal `ResponseReceivedPayload`
// (the LLM-call output-side audit payload; not barrel-exported but
// future-proofed against accidental cross-domain naming clash).
//
// Minimum-viable closed-list field set per Ruling 3 (deferral of
// response_classification / response_channel / response_excerpt_sha256
// to future PRs unless Loop 1 mandates):
//   - response_received_at: ISO-8601 timestamp the recruiter received
//     the response. Distinct from the event row's created_at.
//   - recorded_by_user_id: which recruiter recorded the response —
//     derived from authContext.sub at the controller boundary.
//   - outreach_event_ref_id: UUID reference to the prior outreach_sent
//     TalentEngagementEvent this response is responding to. Repository
//     validates the reference at write time per Ruling 4 (must exist
//     in same tenant + same engagement + event_type='outreach_sent').
//
// Stored as Postgres jsonb in event_payload. TalentEngagementEventView
// types event_payload as `unknown`; consumers narrow at the consumption
// site (M5 PR-2 design).

export interface EngagementResponseReceivedPayload {
  response_received_at: string;
  recorded_by_user_id: string;
  outreach_event_ref_id: string;
}
