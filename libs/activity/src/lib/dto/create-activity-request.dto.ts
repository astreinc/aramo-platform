// CreateActivityRequestDto — POST /v1/activities payload (manual entry).
// tenant_id is derived from AuthContext.tenant_id, never the body.
//
// The pipeline_status_change kind is NOT permitted on this manual route;
// it is emitted only via the in-tx insertActivityInTx helper inside the
// pipeline transition. Manual entries are restricted to the
// recruiter-authored kinds (note | call | email_logged).
export interface CreateActivityRequestDto {
  type: 'note' | 'call' | 'email_logged';
  subject_type?: string;
  subject_id?: string;
  notes?: string;
  site_id?: string;
}
