import type {
  TalentProfileValueState,
  TalentProfileSourceType,
  TalentProfileProjectionPolicy,
  TalentProfileResolutionStatus,
  TalentProfileResolutionReason,
} from '../talent-record-reconcile.repository.js';

// TALENT-INTEL-1 TI-1D-B — the field-state READ MODEL response shape (a DEDICATED
// read surface, NOT getById — getById stays the operational Talent projection).
// Per-field: the control state + resolution summary + evidence-linkage provenance,
// plus current_value read from the canonical TalentRecord projection. No raw
// EvidenceRecord payload — only the evidence_id reference (ruling rail).
export interface TalentProfileFieldStateItem {
  field_key: string;
  // The field's CURRENT operational value from the TalentRecord projection (the
  // sole source of truth); null when the slot is empty. proposed_value is NEVER
  // this — it is a review-only proposed value, never Talent truth.
  current_value: string | null;
  value_state: TalentProfileValueState;
  source_type: TalentProfileSourceType;
  projection_policy: TalentProfileProjectionPolicy;
  provenance: { evidence_id: string } | null;
  // Populated ONLY while resolution_status = PENDING_REVIEW; cleared on resolve.
  proposed_value: string | null;
  resolution_status: TalentProfileResolutionStatus;
  resolution_reason: TalentProfileResolutionReason | null;
}

export interface TalentProfileFieldStateResponse {
  talent_record_id: string;
  fields: TalentProfileFieldStateItem[];
}
