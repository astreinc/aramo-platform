// Lane2-DDR §0/§6 — the Pipeline is the consideration aggregate "for a canonical Talent":
// an episode may only be born for a Talent that exists IN THE CALLER'S TENANT. The
// (scope:ats) Pipeline holds talent_record_id as a cross-schema UUID reference (no FK,
// Architecture §7.3), so the existence fact is talent-record truth. This is the
// dependency-inversion PORT by which the Pipeline asks for it WITHOUT importing
// @aramo/talent-record (no new nx edge); the concrete adapter lives at the apps/api
// composition root and is bound to TALENT_RECORD_EXISTENCE_READER @Global — mirroring
// RESUME_EDITION_READER / QUALIFIED_TRANSITION_GUARD. A STRING token (not the bare
// interface) avoids the non-strict app.get bare-class provider-collision trap.

export const TALENT_RECORD_EXISTENCE_READER = 'TALENT_RECORD_EXISTENCE_READER';

export interface TalentRecordExistenceReaderPort {
  // true iff a TalentRecord with this id exists in this tenant. Tenant-safe: an id that
  // belongs to another tenant resolves false exactly as an absent one does.
  existsInTenant(input: { tenant_id: string; talent_record_id: string }): Promise<boolean>;
}
