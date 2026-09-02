// Repository I/O types for the pre-start-requirement module (Track 3 / E2).
//
// These are internal function-signature types, NOT HTTP DTOs. The guarded HTTP
// surface + request/response DTOs live in apps/api (LIB BOUNDARY). They describe
// what the repositories consume and return.

import type {
  RequirementDefinitionInput,
  RequirementStatusValue,
  RequirementTypeValue,
  SatisfactionPolicyValue,
  ScopeTypeValue,
  SetStateValue,
  WaiverModeValue,
} from './pre-start-requirement-vocab.js';

// A scope selector. TENANT-only today (§4b finding): scope === 'TENANT' and
// scope_ref_id === tenant_id. The pair is the seam for future client/requisition
// scopes; no precedence resolution is implemented.
export type ScopeSelector = {
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
};

// ---- Definition sets ----------------------------------------------------------

export type CreateDraftSetInput = {
  readonly tenant_id: string;
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
  readonly version: string;
  readonly definitions: readonly RequirementDefinitionInput[];
};

export type EditDraftSetInput = {
  readonly tenant_id: string;
  readonly set_id: string;
  readonly definitions: readonly RequirementDefinitionInput[];
};

export type PublishSetInput = {
  readonly tenant_id: string;
  readonly set_id: string;
  readonly published_by: string;
};

export type DefinitionView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly set_id: string;
  readonly requirement_type: RequirementTypeValue;
  readonly label: string;
  readonly blocking: boolean;
  readonly owner_role: string | null;
  readonly sequence: number;
  readonly waiver_mode: WaiverModeValue;
  readonly satisfaction_policy: SatisfactionPolicyValue;
  readonly created_at: Date;
};

export type SetView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
  readonly version: string;
  readonly state: SetStateValue;
  readonly checksum: string;
  readonly published_at: Date | null;
  readonly published_by: string | null;
  readonly effective_to: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly definitions: readonly DefinitionView[];
};

// ---- Instances ----------------------------------------------------------------

// Materialization is placement-scoped and idempotent. actor context is recorded
// on the intent, not the instance snapshot.
export type MaterializeInput = {
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
};

export type InstanceView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly definition_set_id: string;
  readonly definition_set_version: string;
  readonly definition_set_checksum: string;
  readonly requirement_definition_id: string;
  readonly requirement_type: RequirementTypeValue;
  readonly label: string;
  readonly blocking: boolean;
  readonly owner_role: string | null;
  readonly waiver_mode: WaiverModeValue;
  readonly satisfaction_policy: SatisfactionPolicyValue;
  readonly status: RequirementStatusValue;
  readonly completed_at: Date | null;
  readonly completed_by: string | null;
  readonly evidence_reference: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

// A non-waiver status move (SATISFIED / FAILED / CANCELED, or REOPENED back to
// PENDING). Waivers use WaiveInput — waiver authority is evaluated separately
// against the snapshotted waiver_mode.
export type StatusMoveInput = {
  readonly tenant_id: string;
  readonly requirement_instance_id: string;
  readonly to: RequirementStatusValue;
  readonly actor_id: string;
  readonly actor_type: string;
  readonly reason?: string;
  readonly justification?: string;
  readonly source?: string;
  readonly completed_by?: string;
  readonly evidence_reference?: string;
};

// A waiver. authority is the waiver-authority class asserted by the caller;
// it is validated against the instance's snapshotted waiver_mode (NOT the live
// definition) before the move is permitted.
export type WaiveInput = {
  readonly tenant_id: string;
  readonly requirement_instance_id: string;
  readonly authority: string;
  readonly actor_id: string;
  readonly actor_type: string;
  readonly justification: string;
  readonly source?: string;
  // L5-P5 — OPTIONAL supporting evidence pointer for the waiver (ruling P5: no
  // hard-null). authority + justification remain mandatory.
  readonly evidence_reference?: string;
};

// L5-P6 (ruling P4) — the governed verification of a VERIFICATION_REQUIRED
// requirement: a distinct verifier moves it to SATISFIED (separation of duties from
// the :act path). Refused (not applicable) for a SELF_ATTEST requirement.
export type VerifyInput = {
  readonly tenant_id: string;
  readonly requirement_instance_id: string;
  readonly actor_id: string;
  readonly actor_type: string;
  readonly justification?: string;
  readonly source?: string;
  readonly evidence_reference?: string;
};

export type AuditView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly requirement_instance_id: string;
  readonly action: string;
  readonly actor_id: string;
  readonly actor_type: string;
  readonly authority: string | null;
  readonly reason: string | null;
  readonly justification: string | null;
  readonly source: string | null;
  readonly previous_status: RequirementStatusValue;
  readonly resulting_status: RequirementStatusValue;
  readonly created_at: Date;
};

// ---- Blocking assessment (the lib's readiness contribution) -------------------

// The lib exposes assessment only — it never transitions the placement and never
// stores a placement-level is_blocked flag. `materialized` is false when no
// snapshot exists for the placement (fail-closed: the app-layer gate refuses).
export type BlockingAssessment = {
  readonly placement_process_id: string;
  readonly materialized: boolean;
  readonly total: number;
  readonly unresolved_blocking: readonly InstanceView[];
  readonly ready: boolean;
};

// L5-P4 (ruling P3) — the BLOCKED projection. BLOCKED's authoritative cause is a
// blocking requirement in FAILED (intervention needed), derived from the requirement
// facts — never a separate blocker store. PENDING/IN_PROGRESS blocking requirements
// are normal onboarding (PRE_START), NOT a block.
export type BlockerProjection = {
  readonly placement_process_id: string;
  readonly blocked: boolean;
  readonly failed_blocking: readonly InstanceView[];
};

// ---- Materialization intent (reconciler work record) --------------------------

export type IntentStatus = 'pending' | 'resolved' | 'quarantined';

export type IntentView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly scope: ScopeTypeValue;
  readonly scope_ref_id: string;
  // L5-P5 — the layered materialization context captured at intake, so the
  // reconciler can re-resolve the same TENANT->CLIENT->REQUISITION chain. Nullable:
  // a placement with no client/requisition ref resolves TENANT-only.
  readonly client_id: string | null;
  readonly requisition_id: string | null;
  readonly status: IntentStatus;
  readonly attempts: number;
  readonly quarantine_reason: string | null;
  readonly last_attempt_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
};

// L5-P5 — the layered resolution context beyond the tenant (always present). Either
// ref may be null (that layer is skipped in the merge).
export type LayeredContext = {
  readonly client_id: string | null;
  readonly requisition_id: string | null;
};

// ---- Readiness decision ledger (Lane 5 / L5-P3, ruling P7) ---------------------

export type ReadinessDecisionResult = 'READY' | 'REFUSED';
export type ReadinessRefusalReason = 'materialization_absent' | 'blocking_unresolved';

// The immutable record of one MARK_READY decision — success or refusal.
export interface RecordReadinessDecisionInput {
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly result: ReadinessDecisionResult;
  readonly refusal_reason: ReadinessRefusalReason | null;
  readonly materialized: boolean;
  readonly total_requirements: number;
  readonly unresolved_blocking_count: number;
  readonly actor_id: string;
  // 'user' | 'system'
  readonly actor_type: string;
}

export type ReadinessDecisionView = {
  readonly id: string;
  readonly tenant_id: string;
  readonly placement_process_id: string;
  readonly result: ReadinessDecisionResult;
  readonly refusal_reason: ReadinessRefusalReason | null;
  readonly materialized: boolean;
  readonly total_requirements: number;
  readonly unresolved_blocking_count: number;
  readonly actor_id: string;
  readonly actor_type: string;
  readonly created_at: Date;
};
