// Settings S5c-3 — hand-mirrored types for the three assignment editors.
//
// Mirror sources (NO @aramo/* import — apps/tenant-console stays a leaf
// consumer of the HTTP surface; the FE-isolation rule from S5a/S5b/
// S5c-1/S5c-2):
//   D — UserClientAssignmentRow: libs/company/src/lib/user-client-assignment.repository.ts
//   E — TeamClientOwnershipRow:  libs/company/src/lib/team-client-ownership.repository.ts
//   F — RequisitionAssignmentView: libs/requisition/src/lib/dto/requisition-assignment.view.ts
//
// The BE row carries Date on its TS side; the JSON wire encodes them
// as ISO strings. The FE mirrors the wire shape.

// ─── D — Company-assignments (user → company) ─────────────────────────

export interface UserClientAssignmentRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly company_id: string;
  readonly assigned_at: string;
  readonly assigned_by_id: string | null;
}

export interface UserClientAssignmentListView {
  readonly items: readonly UserClientAssignmentRow[];
}

export interface AssignUserRequest {
  readonly user_id: string;
}

export interface AssignUserResponse {
  readonly id: string;
  readonly user_id: string;
  readonly company_id: string;
}

// ─── E — Team-clients (team → company) ────────────────────────────────

export interface TeamClientOwnershipRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly team_id: string;
  readonly company_id: string;
  readonly assigned_at: string;
  readonly assigned_by_id: string | null;
}

export interface TeamClientOwnershipListView {
  readonly items: readonly TeamClientOwnershipRow[];
}

export interface AddTeamClientRequest {
  readonly company_id: string;
}

export interface AddTeamClientResponse {
  readonly id: string;
  readonly team_id: string;
  readonly company_id: string;
}

// ─── F — Requisition-assign (user → requisition) ──────────────────────

export interface RequisitionAssignmentView {
  readonly id: string;
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly user_id: string;
  readonly assigned_at: string;
  readonly assigned_by_id: string | null;
}

export interface RequisitionAssignmentListView {
  readonly items: readonly RequisitionAssignmentView[];
}

export interface AssignRequisitionRequest {
  readonly user_id: string;
}
