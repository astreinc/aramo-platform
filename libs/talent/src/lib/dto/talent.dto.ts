// TalentDto — public shape of the Talent core entity.
// Tenant-agnostic by design: no tenant_id field.
// Per Talent Record Spec §2.2 / PR-10 directive §4.1.
export interface TalentDto {
  id: string;
  // Closed vocabulary (Talent Record Spec §2.2):
  //   active | inactive | archived | deleted
  lifecycle_status: string;
  created_at: string;
  updated_at: string;
}
