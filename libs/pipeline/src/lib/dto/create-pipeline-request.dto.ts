// CreatePipelineRequestDto — POST /v1/pipelines payload.
// tenant_id is derived from AuthContext.tenant_id, never the body.
// Initial status is hard-coded to `no_contact` in the repository
// (directive §2 "Initial state"); not accepted from the body.
export interface CreatePipelineRequestDto {
  talent_record_id: string;
  requisition_id: string;
  site_id?: string;
}
