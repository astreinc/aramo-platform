import type {
  TalentProfileProjectionPolicy,
  TalentProfileResolutionReason,
  TalentProfileResolutionStatus,
  TalentProfileSourceType,
  TalentProfileValueState,
} from '../talent-record-reconcile.repository.js';

// TALENT-INTEL-1 TI-1E-A — the aggregate profile-hydration read projection.
//
// A DERIVED read that answers, for the complete governed editable field set:
// what to DISPLAY (current_value + value_state), WHERE the value came from
// (source_type + provenance), and whether it needs ATTENTION (resolution_*).
// It reuses the TI-1D-B field-state vocabulary rather than inventing another.
//
// It NEVER runs extraction, NEVER reconciles, NEVER writes. TalentRecord stays
// the operational projection; field-state/provenance stay the governance
// authority. The server owns the precedence ONCE so the browser consumes state
// rather than reconstructing it.

// Widened from the field-state DTO's string|null so the projection returns the
// real Talent column types (booleans stay booleans, never stringified). string[]
// is reserved for genuinely multi-valued fields; no field emits it today.
export type ProfileHydrationValue = string | number | boolean | string[] | null;

export interface ProfileHydrationItem {
  readonly field_key: string;
  // What the UI should DISPLAY — the current operational value, typed.
  readonly current_value: ProfileHydrationValue;
  // Governance/display state: UNKNOWN (Aramo holds no authoritative value) |
  // SET (a value is present) | EXPLICITLY_CLEARED (a governed action removed it;
  // reconcile must not silently refill).
  readonly value_state: TalentProfileValueState;
  // WHERE a GOVERNED value came from. null = plain operational value with no
  // governed provenance (never fabricated for operational-only fields).
  readonly source_type: TalentProfileSourceType | null;
  readonly projection_policy: TalentProfileProjectionPolicy;
  // Evidence linkage; null unless a provenance row exists. source_type is NOT a
  // substitute for provenance.
  readonly provenance: { readonly evidence_id: string } | null;
  readonly resolution_status: TalentProfileResolutionStatus;
  readonly resolution_reason: TalentProfileResolutionReason | null;
  // Populated only while resolution_status = PENDING_REVIEW.
  readonly proposed_value: ProfileHydrationValue;
}

export interface ProfileHydrationResponse {
  readonly talent_record_id: string;
  readonly fields: readonly ProfileHydrationItem[];
}
