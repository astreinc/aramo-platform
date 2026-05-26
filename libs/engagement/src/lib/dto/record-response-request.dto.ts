import { IsDateString, IsNotEmpty, IsUUID } from 'class-validator';

// M5 PR-7 §4.2 — HTTP request DTO for POST /v1/engagements/{id}/response.
//
// Body shape per directive §4.2 + Ruling 3 (minimum-viable closed list):
//   - response_received_at: required ISO-8601 timestamp the recruiter
//     received the talent's response. Distinct from the event row's
//     created_at (which records when the recruiter recorded the event).
//   - outreach_event_ref_id: required UUID reference to the prior
//     outreach_sent TalentEngagementEvent that this response is
//     responding to. Cross-event reference validation at the repository
//     layer per Ruling 4: the referenced event must exist in the same
//     tenant + same engagement + have event_type='outreach_sent'.
//
// recorded_by_user_id is NOT in the body — derived server-side from
// authContext.sub at the controller boundary.
// tenant_id is NOT in the body — derived server-side from JWT
// AuthContext.
export class RecordResponseRequestDto {
  @IsDateString()
  @IsNotEmpty()
  response_received_at!: string;

  @IsUUID()
  outreach_event_ref_id!: string;
}
