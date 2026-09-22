import { IsOptional, IsUUID } from 'class-validator';

// COMM-C4 (RCE-1) — the requisition-contact draft request. The browser supplies
// ONLY ids; the backend reloads every business fact authoritatively and resolves
// the recipient itself. No recipient, subject, or body is accepted here.
export class RequisitionContactEmailDraftRequestDto {
  @IsUUID()
  talent_record_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsOptional()
  @IsUUID()
  pipeline_id?: string;
}
