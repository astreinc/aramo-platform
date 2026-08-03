// Track 3 / E7 — request body for POST
// /v1/clients/{client_company_id}/talent/{talent_record_id}/restrictions/{restriction_id}/close.
//
// The explicit close. All five closure-provenance values are required
// together with effective_to (§3b correction 3). closed_by + closed_at
// are server-derived (JWT actor + now), never client-supplied.
export interface CloseRestrictionRequestDto {
  // ISO 8601 — the actual business-effective end. Must be >= effective_from
  // and (when a scheduled_end_at exists) not after it (early close only).
  effective_to: string;
  close_reason_code: string;
  close_source_system: string;
  close_source_reference: string;
}
