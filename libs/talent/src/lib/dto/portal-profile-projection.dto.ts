// M3 PR-9 §4.2 — PortalProfileProjection — the R10-filtered talent
// self-profile shape returned by TalentService.findSelfProfile.
//
// This shape is what a talent sees about themselves in the portal context:
// their own id, the tenant context, their lifecycle/tenant statuses, the
// channel they entered through, and when they joined the tenant. EXCLUDES:
// source_recruiter_id (recruiter-internal — R10/R8 risk), any examination
// or match data (not on the Talent entity, but explicit reminder), and any
// timestamps that could leak operational metadata not in API Contracts
// Phase 3 Profile group.
//
// Defined in libs/talent rather than libs/portal to avoid a circular
// import: libs/portal already depends on libs/talent for TalentService.
// libs/portal's PortalProfileDto is structurally identical and the
// controller forwards this projection verbatim.

export interface PortalProfileProjection {
  talent_id: string;
  tenant_id: string;
  lifecycle_status: string;
  tenant_status: string;
  source_channel: string;
  created_at: string;
}
