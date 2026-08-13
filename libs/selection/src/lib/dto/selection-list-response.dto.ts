import type { TalentSelectionView } from './talent-selection.view.js';

// R7 BE-prereq P1 §1 — HTTP response DTO for GET /v1/selections 200.
//
// Returns the actor's visible selections (D4b-composed: selection is
// visible iff its requisition_id is in the actor's visible-requisition
// set). Filter semantics — both ?talent_id and ?requisition_id are
// optional; no filter ⇒ all visible selections; talent_id ⇒ that
// talent's visible selections; requisition_id ⇒ that requisition's
// visible selections (empty when the requisition itself is invisible);
// both ⇒ the intersection (at most one row — the natural key is
// (tenant, talent, requisition)).
//
// Envelope shape matches the established ATS list convention
// ({ items: View[] }) used by requisitions / companies / talent-records.
export interface SelectionListResponseDto {
  items: TalentSelectionView[];
}
