import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

// COMM-C4 (RCE-1) + D-EMAIL-TPL-1 (ET-5) — the requisition-contact draft request.
// The browser supplies ONLY ids and an optional template_key; the backend reloads
// every business fact authoritatively and resolves the recipient itself. No
// recipient, subject, body, or context is accepted here.
export class RequisitionContactEmailDraftRequestDto {
  @IsUUID()
  talent_record_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsOptional()
  @IsUUID()
  pipeline_id?: string;

  // ET-5 — the ONLY new client input: which template to render (a logical KEY,
  // never recipient/subject/body/context). Bounded; an invalid key fails closed
  // server-side. Absent → the code-owned default (behaviour unchanged).
  @IsOptional()
  @IsString()
  @MaxLength(120)
  template_key?: string;
}
