// Track 3 / E7 — request body for
// POST /v1/clients/{client_company_id}/talent/{talent_record_id}/restrictions.
//
// A plain interface (not a class-validator class) — the submittal
// CreateSubmittalRequestDto precedent. Domain validation is performed
// manually in the controller so the single E7-mandated 422 refusal
// RESTRICTION_INVALID (details.reason names the case) wins over
// class-validator's generic 400.
//
// client_company_id + talent_record_id come from the SCOPED ROUTE PATH,
// never the body (E7 §2b — the route shape enforces R2/R3). recorded_by
// comes from the JWT. effective_to and the five closure columns are NOT
// accepted here (closure-only, §3b correction 3).
export interface CreateRestrictionRequestDto {
  restriction_type: string;

  // Three distinct provenance facts (§3b correction 1). All three of
  // asserted_by_type / source_system / source_reference are REQUIRED (R1).
  asserted_by_type: string;
  asserting_organization_reference?: string | null;
  asserting_contact_reference?: string | null;
  source_system: string;
  source_reference: string;

  // raw_source_value — OPTIONAL (PO ruling). A VMS webhook may carry no
  // verbatim payload; requiring it would force a placeholder worse than null.
  raw_source_value?: string | null;
  reason_code: string;

  // ISO 8601 timestamps.
  effective_from: string;
  // scheduled_end_at — asserted expiry known at creation (Option B).
  // Optional, immutable once set. Must be > effective_from when present.
  scheduled_end_at?: string | null;
}
