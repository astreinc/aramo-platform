import type {
  AssertedByTypeValue,
  CloseReasonCodeValue,
  RestrictionTypeValue,
  SourceSystemValue,
} from '../client-talent-restriction-vocab.js';

// Read projection over a ClientTalentRestriction row (Track 3 / E7).
//
// `active` is DERIVED at read time, never stored (E7 Option B — no mutable
// is_active flag). It is computed against the supplied `now`:
//   active = effective_from <= now
//     AND (scheduled_end_at IS NULL OR scheduled_end_at > now)
//     AND (effective_to   IS NULL OR effective_to   > now)
export interface ClientTalentRestrictionView {
  id: string;
  tenant_id: string;
  client_company_id: string;
  talent_record_id: string;
  restriction_type: RestrictionTypeValue;

  asserted_by_type: AssertedByTypeValue;
  asserting_organization_reference: string | null;
  asserting_contact_reference: string | null;
  source_system: SourceSystemValue;
  source_reference: string;
  raw_source_value: string | null;
  reason_code: string;
  recorded_by: string;

  effective_from: Date;
  scheduled_end_at: Date | null;
  recorded_at: Date;

  effective_to: Date | null;
  closed_at: Date | null;
  closed_by: string | null;
  close_reason_code: CloseReasonCodeValue | null;
  close_source_system: SourceSystemValue | null;
  close_source_reference: string | null;

  // Derived — never persisted.
  active: boolean;
}

// CreateRestrictionInput — repository-layer input. tenant_id +
// client_company_id + talent_record_id come from the scoped route path;
// recorded_by comes from the JWT. effective_to and all five closure
// columns are NOT accepted at create (E7 §3b correction 3 — closure-only).
export interface CreateRestrictionInput {
  tenant_id: string;
  client_company_id: string;
  talent_record_id: string;
  restriction_type: RestrictionTypeValue;

  asserted_by_type: AssertedByTypeValue;
  asserting_organization_reference?: string | null;
  asserting_contact_reference?: string | null;
  source_system: SourceSystemValue;
  source_reference: string;
  raw_source_value: string | null;
  reason_code: string;
  recorded_by: string;

  effective_from: Date;
  // scheduled_end_at — the asserted expiry known at creation (Option B).
  // Immutable once set. Optional.
  scheduled_end_at?: Date | null;
}

// CloseRestrictionInput — repository-layer input for the explicit close.
// All five closure-provenance values are required together with
// effective_to (§3b correction 3). closed_by comes from the JWT.
export interface CloseRestrictionInput {
  tenant_id: string;
  client_company_id: string;
  talent_record_id: string;
  restriction_id: string;

  effective_to: Date;
  closed_by: string;
  close_reason_code: CloseReasonCodeValue;
  close_source_system: SourceSystemValue;
  close_source_reference: string;
}

// Response shapes.
export interface CreateRestrictionResponseDto {
  restriction: ClientTalentRestrictionView;
}
export interface CloseRestrictionResponseDto {
  restriction: ClientTalentRestrictionView;
}

// GET .../current — "is this person restricted at this client, now?".
// Returns the boolean plus the active source-attributed records WITHIN
// the one client-talent context (permitted per E7 §"Currently restricted").
// It is NOT a cross-client / cross-source person-level count.
export interface CurrentRestrictionsResponseDto {
  restricted: boolean;
  active_restrictions: ClientTalentRestrictionView[];
}

// GET .../history — all source-attributed records for the one client-talent
// context (active and ended). Never a cross-client surface.
export interface RestrictionHistoryResponseDto {
  restrictions: ClientTalentRestrictionView[];
}
