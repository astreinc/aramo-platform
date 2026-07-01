// M3 PR-9 §4.3 — PortalProfileDto — the public response shape of
// GET /v1/portal/profile.
//
// Structurally identical to talent-record's PortalProfileProjection (which
// is what TalentRecordService.findSelfProfile returns); duplicated here so
// libs/portal owns its API surface DTO independently of where the data
// comes from. R10-filtered by construction: any field that names
// internal_reasoning, entrustability_tier_raw, override_*, or recruiter_*
// would be caught by ci/scripts/verify-portal-refusal.ts at CI time —
// this DTO ships none of those.
//
// 4e-rest-b: lifecycle_status DROPPED (a Core `Talent` field with no
// TalentRecord equivalent — the profile re-homed onto the ATS heart).
// tenant_status remains the profile's status field.
//
// Mirrors openapi/portal.yaml#/components/schemas/PortalProfile.

export interface PortalProfileDto {
  talent_id: string;
  tenant_id: string;
  tenant_status: string;
  source_channel: string;
  created_at: string;
}
