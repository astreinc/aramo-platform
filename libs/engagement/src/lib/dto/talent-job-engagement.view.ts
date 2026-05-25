import type { EngagementStateValue } from '../engagement-state.js';

// Typed view projection for TalentJobEngagement reads (M5 PR-1
// Directive v1.0 §4.5). The repository projects raw rows through this
// shape on read; per-PR observability standard logs the canonical
// fields visible here.
//
// `examination_id` is nullable per Directive Ruling 5 + Amendment v1.1
// (engagement may exist before examination is computed; pin-verify
// lands at M5 PR-8). `created_at` carries through as Date — the
// repository surfaces persisted Postgres timestamps unmodified.
export interface TalentJobEngagementView {
  id: string;
  tenant_id: string;
  talent_id: string;
  requisition_id: string;
  examination_id: string | null;
  state: EngagementStateValue;
  created_at: Date;
}
