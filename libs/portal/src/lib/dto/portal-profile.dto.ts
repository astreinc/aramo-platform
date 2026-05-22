// M3 PR-9 §4.3 — PortalProfileDto — the public response shape of
// GET /v1/portal/profile.
//
// Structurally identical to libs/talent's PortalProfileProjection (which
// is what TalentService.findSelfProfile returns); duplicated here so
// libs/portal owns its API surface DTO independently of where the data
// comes from. R10-filtered by construction: any field that names
// internal_reasoning, entrustability_tier_raw, override_*, or recruiter_*
// would be caught by ci/scripts/verify-portal-refusal.ts at CI time —
// this DTO ships none of those.
//
// Mirrors openapi/portal.yaml#/components/schemas/PortalProfile.

export interface PortalProfileDto {
  talent_id: string;
  tenant_id: string;
  lifecycle_status: string;
  tenant_status: string;
  source_channel: string;
  created_at: string;
}
