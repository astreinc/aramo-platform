import { IsUUID } from 'class-validator';

// COMM-RECRUITER-W1 (W1-A2) — General Talent Contact draft request. Talent-only:
// the browser supplies ONLY the talent id. NO requisition, NO recipient email, NO
// subject/body, NO template choice — every business fact is reloaded server-side
// and the template is governed (tenant override → code default).
export class GeneralTalentContactDraftRequestDto {
  @IsUUID()
  talent_record_id!: string;
}
