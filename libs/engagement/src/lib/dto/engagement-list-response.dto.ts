import type { TalentJobEngagementView } from './talent-job-engagement.view.js';

// R7 BE-prereq P1 §1 — HTTP response DTO for GET /v1/engagements 200.
//
// Returns the actor's visible engagements (D4b-composed: engagement is
// visible iff its requisition_id is in the actor's visible-requisition
// set). Filter semantics — both ?talent_id and ?requisition_id are
// optional; no filter ⇒ all visible engagements; talent_id ⇒ that
// talent's visible engagements; requisition_id ⇒ that requisition's
// visible engagements (empty when the requisition itself is invisible);
// both ⇒ the intersection (at most one row — the natural key is
// (tenant, talent, requisition)).
//
// Envelope shape matches the established ATS list convention
// ({ items: View[] }) used by requisitions / companies / talent-records.
export interface EngagementListResponseDto {
  items: TalentJobEngagementView[];
}
