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
// Portal P2 P2b (§PR-2 ruling 2) — tenant_name: the P1-deferred MAY is now a
// MUST. The engagement counterparty is NAMED (P-R5) so the portal user (and the
// consent grant flow's chrome) sees a human label, not a UUID. It is the
// always-present workspace name from @aramo/identity (Tenant.name), resolved by
// the controller via TenantService; null only if the tenant row vanished
// (defensive). ENGAGEMENT-class — a portal user's own engagements, never a
// verification origin — so naming carries no origin-secrecy concern and this
// stays clear of TRUST_CLASS_SCHEMAS.
//
// Mirrors openapi/portal.yaml#/components/schemas/PortalProfile.

export interface PortalProfileDto {
  talent_id: string;
  tenant_id: string;
  tenant_name: string | null;
  tenant_status: string;
  source_channel: string;
  created_at: string;
}
