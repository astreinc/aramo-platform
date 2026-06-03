// TalentLinkView — read projection for the link status of a TalentRecord.
//
// Returned by GET /v1/talent-records/:id/link and the POST/DELETE link
// endpoints. Carries the minimum necessary surface — talent_record_id
// + the current core_talent_id (null when unlinked).
//
// Note: the per-tenant overlay is NOT echoed back in this view. The
// overlay's existence is the GATE for the link (enforced inside
// TalentLinkService.link via TalentRepository.findOverlayByTenant) but
// is not the LINK ITSELF — the link is to the tenant-agnostic Talent
// identity (Option A target), and the overlay is derivable on demand
// from (tenant_id, core_talent_id) by the caller if needed.
export interface TalentLinkView {
  talent_record_id: string;
  core_talent_id: string | null;
}
