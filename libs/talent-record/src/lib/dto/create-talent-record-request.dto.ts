// CreateTalentRecordRequestDto — POST /v1/talent-records payload.
// tenant_id derived from AuthContext.tenant_id (never the body).
export interface CreateTalentRecordRequestDto {
  first_name: string;
  last_name: string;
  site_id?: string;
  email1?: string;
  email2?: string;
  phone_home?: string;
  phone_cell?: string;
  phone_work?: string;
  address?: string;
  address2?: string;
  city?: string;
  state?: string;
  zip?: string;
  source?: string;
  key_skills?: string;
  current_employer?: string;
  current_pay?: string;
  desired_pay?: string;
  date_available?: string;
  can_relocate?: boolean;
  is_hot?: boolean;
  notes?: string;
  web_site?: string;
  best_time_to_call?: string;
  owner_id?: string;
}
