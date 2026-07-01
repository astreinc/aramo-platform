// TalentLinkView — read projection for the link status of a TalentRecord.
//
// Returned by GET /v1/talent-records/:id/link and the POST/DELETE link
// endpoints. Carries the minimum honest surface — the tenant-local
// talent_record_id + a boolean is_linked.
//
// 4e-rest: the Core-Talent link (core_talent_id) was dropped; the link is
// now the PERSON_CLUSTER pointer (identity_index). cluster_id is a
// cross-tenant id and is DELIBERATELY NOT echoed here — the view exposes
// only WHETHER the record is linked, not the cross-tenant cluster id.
// (No linked_at: TalentRecord has no honest link-timestamp column, and
// updated_at bumps on any edit — aliasing it would lie.)
export interface TalentLinkView {
  talent_record_id: string;
  is_linked: boolean;
}
