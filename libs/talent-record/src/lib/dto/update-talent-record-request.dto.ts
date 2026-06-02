// UpdateTalentRecordRequestDto — PATCH /v1/talent-records/:id payload.
export interface UpdateTalentRecordRequestDto {
  first_name?: string;
  last_name?: string;
  email1?: string | null;
  email2?: string | null;
  phone_home?: string | null;
  phone_cell?: string | null;
  phone_work?: string | null;
  address?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  source?: string | null;
  key_skills?: string | null;
  current_employer?: string | null;
  current_pay?: string | null;
  desired_pay?: string | null;
  date_available?: string | null;
  can_relocate?: boolean;
  is_hot?: boolean;
  notes?: string | null;
  web_site?: string | null;
  best_time_to_call?: string | null;
  owner_id?: string | null;
}
