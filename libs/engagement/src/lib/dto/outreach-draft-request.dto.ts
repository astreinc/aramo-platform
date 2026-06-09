import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

// Outreach Draft/Preview Directive v1.0 / Amendment v1.1 §1 — HTTP request
// DTO for POST /v1/engagements/{id}/outreach/draft.
//
// This is the generation half of the draft→preview→send split. The body
// is the prompt shape the atomic POST .../outreach formerly carried
// (DRAFT runs the LLM; SEND no longer takes a prompt — it takes the
// approved final_text, see OutreachSendRequestDto).
//
//   - prompt: required non-empty string (the user-supplied LLM prompt;
//     AiDraftService applies pre-redaction before sending to the
//     provider).
//   - max_tokens: optional positive integer; defaults to 512 at the
//     controller boundary when omitted.
//   - system_message: optional system message passed through to the
//     provider verbatim.
//   - recipient_handle: optional opaque handle the caller can attach for
//     correlation. Recipient resolution from TalentContactMethod remains
//     deferred — the substrate does not look up contact rows.
//
// tenant_id derived from JWT AuthContext (NOT in body).
export class OutreachDraftRequestDto {
  @IsString()
  @IsNotEmpty()
  prompt!: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  max_tokens?: number;

  @IsOptional()
  @IsString()
  system_message?: string;

  @IsOptional()
  @IsString()
  recipient_handle?: string;
}
