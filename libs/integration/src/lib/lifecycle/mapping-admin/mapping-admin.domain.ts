// L1-D3-A (R1/R3/R4/R5) — VMS Lifecycle Mapping Administration domain vocabulary +
// view/input shapes. This is the mapping-admin's OWN bounded vocabulary, owned by
// the integration/connector domain (which subset of Aramo lifecycle actions this
// connector exposes for EXTERNAL authoring). It deliberately does NOT import the
// @aramo/requisition runtime allowlist — that would add a new nx edge and couple the
// integration schema to the requisition action enum, the exact coupling the bare
// String `mapped_action` column avoids (ADR-0030 — no new I15 edge). Drift from the
// canonical EXTERNAL_LIFECYCLE_ACTIONS is caught by an apps/api consistency test that
// legitimately imports both libs. The DB CHECK (migration) is the authoritative
// persistence boundary.

/** The mapping-set lifecycle (bounded String; mirrors the reconciliation-status
 * convention). 'active' is the only runtime-resolved state; exactly one per
 * (tenant, connection) — the partial unique index enforces it. */
export const MAPPING_SET_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  HISTORICAL: 'historical',
} as const;
export type MappingSetStatus = (typeof MAPPING_SET_STATUS)[keyof typeof MAPPING_SET_STATUS];

/** The authored disposition (R3). EXECUTE_ACTION invokes the mapped governed
 * command; IGNORE is a deliberate no-op (this provider state carries no Lane-1
 * lifecycle authority). No authored RECONCILE — reconciliation is the exception
 * path (no/invalid mapping), never an authored choice. */
export const MAPPING_DISPOSITION = {
  EXECUTE_ACTION: 'EXECUTE_ACTION',
  IGNORE: 'IGNORE',
} as const;
export type MappingDisposition = (typeof MAPPING_DISPOSITION)[keyof typeof MAPPING_DISPOSITION];

/** The four externally-authorable Aramo lifecycle actions (R2/R4). The connector
 * may only author these — SUBMIT_FOR_APPROVAL/APPROVE/REJECT are internal
 * governance and are NEVER externally authorable; CLOSE_SUBMITTALS is a non-governed
 * status edit deferred to a future slice. Kept as this lib's own bounded vocabulary
 * (see file header) and asserted === @aramo/requisition EXTERNAL_LIFECYCLE_ACTIONS
 * by an apps/api consistency test. */
export const MAPPING_ADMIN_ALLOWED_ACTIONS = ['REOPEN', 'PUT_ON_HOLD', 'CLOSE', 'CANCEL'] as const;
export type MappingAdminAllowedAction = (typeof MAPPING_ADMIN_ALLOWED_ACTIONS)[number];

/** The only authority mode authorable via the admin API (R5). Existing
 * 'dual_control' rows are preserved + read honestly, never newly authored here. */
export const MAPPING_ADMIN_AUTHORITY_MODE = 'external_authority' as const;

export function isMappingAdminAllowedAction(action: string): action is MappingAdminAllowedAction {
  return (MAPPING_ADMIN_ALLOWED_ACTIONS as readonly string[]).includes(action);
}

/** Canonical provider-state normalization (trim + lowercase). BOTH the admin
 * author path (stored key) and the runtime reconciler lookup MUST derive their key
 * from THIS single function, so an authored 'Halted' matches an observed 'Halted'
 * at runtime. The reconciler imports it (replacing its private normalize) so the two
 * can never drift. */
export function normalizeProviderState(raw: string): string {
  return raw.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Authoring input (one draft mapping row).
// ---------------------------------------------------------------------------

/** One authored mapping row in a draft set. `mapped_action` is required iff
 * disposition = EXECUTE_ACTION, and MUST be absent/null iff IGNORE (R4). */
export interface DraftMappingRowInput {
  readonly provider_state: string;
  readonly disposition: MappingDisposition;
  readonly mapped_action?: string | null;
}

// ---------------------------------------------------------------------------
// Views (serialized API shapes — no credential, no raw provider payload).
// ---------------------------------------------------------------------------

export interface MappingRowView {
  readonly id: string;
  readonly provider_state: string;
  readonly disposition: string;
  readonly mapped_action: string | null;
  readonly authority_mode: string;
}

export interface MappingSetSummaryView {
  readonly id: string;
  readonly connection_id: string;
  readonly version: number;
  readonly status: string;
  readonly created_at: string;
  readonly created_by: string;
  readonly activated_at: string | null;
  readonly activated_by: string | null;
  readonly supersedes_set_id: string | null;
}

export interface MappingSetDetailView extends MappingSetSummaryView {
  readonly mappings: MappingRowView[];
}

// ---------------------------------------------------------------------------
// Validation (pre-activation) — typed, enumerable errors (R4/R5).
// ---------------------------------------------------------------------------

export type MappingValidationCode =
  | 'DUPLICATE_PROVIDER_STATE'
  | 'EXECUTE_ACTION_REQUIRES_ALLOWED_ACTION'
  | 'IGNORE_FORBIDS_ACTION'
  | 'UNSUPPORTED_AUTHORITY_MODE'
  | 'UNKNOWN_DISPOSITION';

export interface MappingValidationIssue {
  readonly code: MappingValidationCode;
  readonly provider_state: string;
  readonly detail: string;
}
