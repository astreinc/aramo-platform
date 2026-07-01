// 4e-rest-b — PortalProfileProjection — the R10-filtered talent self-profile
// shape returned by TalentRecordService.findSelfProfile.
//
// This shape is what a talent sees about themselves in the portal context:
// their own id, the tenant context, their per-tenant relationship status, the
// channel they entered through, and when the record was created. EXCLUDES:
// source_recruiter_id (recruiter-internal — R10/R8 risk), any examination /
// match data, and any operational metadata not in the API Contracts Phase 3
// Profile group.
//
// 4e-rest re-home: findSelfProfile moved OFF the Core Talent+overlay reader
// (libs/talent) ONTO TalentRecord (this lib, the ATS heart). `lifecycle_status`
// was DROPPED — it was a Core `Talent` field with no TalentRecord equivalent;
// `tenant_status` (the per-tenant relationship status, folded onto TalentRecord
// in 4d) remains the profile's status field. tenant_status / source_channel are
// nullable on TalentRecord, so the reader returns null (→ 404) when either is
// unset (an un-statused record has no presentable self-profile).
export interface PortalProfileProjection {
  talent_id: string;
  tenant_id: string;
  tenant_status: string;
  source_channel: string;
  created_at: string;
}
