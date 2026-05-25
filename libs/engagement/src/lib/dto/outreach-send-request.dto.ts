import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';

// M5 PR-6 §4.2 — HTTP request DTO for POST /v1/engagements/{id}/outreach.
//
// Body shape per directive §4.2:
//   - prompt: required non-empty string (the user-supplied LLM prompt;
//     AiDraftService applies pre-redaction before sending to the
//     provider).
//   - max_tokens: optional positive integer; defaults to 512 at the
//     controller boundary when omitted (per directive §4.1 step 6).
//   - system_message: optional system message passed through to the
//     provider verbatim.
//   - recipient_handle: optional opaque handle the caller can attach
//     for correlation. Recipient resolution from TalentContactMethod is
//     deferred per Ruling 7 — the substrate at PR-6 does not look up
//     contact rows.
//
// tenant_id derived from JWT AuthContext (NOT in body).
export class OutreachSendRequestDto {
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
