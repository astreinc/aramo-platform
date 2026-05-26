import { IsDateString, IsNotEmpty } from 'class-validator';

// M5 PR-8a §4.2 — HTTP request DTO for POST /v1/engagements/{id}/conversation.
//
// Body shape per directive §4.2 + Ruling 3 (minimum-viable closed list):
//   - conversation_started_at: required ISO-8601 timestamp the recruiter
//     began the in-bound conversation with the talent. Distinct from the
//     event row's created_at (which records when the recruiter recorded
//     the event).
//
// recorded_by_user_id is NOT in the body — derived server-side from
// authContext.sub at the controller boundary.
// tenant_id is NOT in the body — derived server-side from JWT
// AuthContext.
//
// Single-field minimum surface (Ruling 3): conversation_channel,
// first_message_excerpt_sha256, conversation_thread_id are deferred to
// future PRs (M5 PR-11+ or M6) unless a directive amendment mandates
// inclusion.
export class RecordConversationStartedRequestDto {
  @IsDateString()
  @IsNotEmpty()
  conversation_started_at!: string;
}
