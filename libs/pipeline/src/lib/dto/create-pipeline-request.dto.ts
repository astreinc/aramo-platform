// CreatePipelineRequestDto — POST /v1/pipelines payload.
// tenant_id is derived from AuthContext.tenant_id, never the body.
// Initial status is hard-coded to `no_contact` in the repository
// (directive §2 "Initial state"); not accepted from the body.
export interface CreatePipelineRequestDto {
  talent_record_id: string;
  requisition_id: string;
  site_id?: string;
  // ADR-0024 §D11 (PR-4b) — the operator's override reason code. REQUIRED only
  // when the policy verdict is REQUIRES_OVERRIDE and the operator holds the
  // named capability; validated at the controller boundary as a closed-set
  // value (→ OVERRIDE_INVALID 422). Absent on the ordinary path.
  override_reason_code?: string;
}
