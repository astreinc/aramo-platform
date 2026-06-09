import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

// Outreach Draft/Preview Directive v1.0 / Amendment v1.1 §2 — HTTP request
// DTO for POST /v1/engagements/{id}/outreach/send.
//
// The delivery half of the draft→preview→send split. SEND no longer takes
// a prompt (that moved to POST .../outreach/draft, OutreachDraftRequestDto);
// it takes the source draft event id + the recruiter-approved final text.
//
//   - draft_event_id: the outreach_drafted event the recruiter is sending
//     from. The repository validates it resolves to an outreach_drafted
//     event on the SAME engagement + SAME tenant (cross-event-ref guard,
//     mirroring recordResponse's outreach_event_ref_id validation) →
//     ENGAGEMENT_REFERENCE_NOT_FOUND 422 otherwise.
//   - final_text: required non-empty string — the text actually delivered.
//     May differ from the source draft's draft_text (the recruiter edited);
//     both persist (editable-trail invariant).
//   - recipient_handle: optional opaque correlation handle.
//
// tenant_id derived from JWT AuthContext (NOT in body).
export class OutreachSendRequestDto {
  @IsUUID()
  draft_event_id!: string;

  @IsString()
  @IsNotEmpty()
  final_text!: string;

  @IsOptional()
  @IsString()
  recipient_handle?: string;
}
