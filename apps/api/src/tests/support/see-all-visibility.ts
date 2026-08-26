import type { VisibilityContextShape } from '@aramo/common';

// L1-B — a see-all VisibilityContextShape for direct-repo update()/delete()
// callers whose SUBJECT is NOT write-visibility (concurrency / lifecycle /
// numbering / onsite-days mechanics). L1-B made the repo's update()/delete()
// visibility param REQUIRED (parity with the read side's findByIdForActor /
// setBookmark, so a forgotten controller wire-up fails typecheck rather than
// silently drifting to see-all). see_all_requisition:true collapses
// buildVisibilityWhere to {} (no filter), preserving the exact pre-L1-B
// behaviour these specs assert — they bypass the HTTP visibility boundary
// deliberately and are not the write-visibility subject.
export const SEE_ALL_VISIBILITY: VisibilityContextShape = {
  tenant_id: '00000000-0000-0000-0000-000000000000',
  actor_user_id: '00000000-0000-0000-0000-000000000000',
  see_all_company: true,
  see_all_requisition: true,
  visible_client_ids: null,
};
