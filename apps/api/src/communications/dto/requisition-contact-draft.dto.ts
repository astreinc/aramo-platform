import { IsOptional, IsUUID } from 'class-validator';

// COMM-C4 (RCE-1) — the requisition-contact draft request. The browser supplies
// ONLY ids; the backend reloads every business fact authoritatively, resolves the
// recipient itself, and resolves the GOVERNED template server-side (tenant
// override else code default — no client template choice,
// COMM-EMAIL-TEMPLATE-GOVERNANCE-1). No recipient, subject, body, context, or
// template is accepted here.
export class RequisitionContactEmailDraftRequestDto {
  @IsUUID()
  talent_record_id!: string;

  @IsUUID()
  requisition_id!: string;

  @IsOptional()
  @IsUUID()
  pipeline_id?: string;
}
