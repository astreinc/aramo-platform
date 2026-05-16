// TalentTenantOverlayDto — public shape of the per-tenant relationship
// record for a Talent. Per Talent Record Spec §2.2 / PR-10 directive §4.2.
// One optional spec field is deferred per directive §4.4 (follow-up F8).
export interface TalentTenantOverlayDto {
  id: string;
  talent_id: string;
  tenant_id: string;
  source_recruiter_id: string | null;
  // Closed vocabulary (Talent Record Spec §2.2):
  //   self_signup | recruiter_capture | referral | import
  source_channel: string;
  tenant_status: string;
  created_at: string;
  updated_at: string;
}
