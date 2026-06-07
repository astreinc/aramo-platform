// Settings S5c-3 — the assignments HTTP client (wires 9 existing
// endpoints across D + E + F; S5c-3 adds no backend routes).
//
// Idempotency contract (UNIFORM across all three editors — PL-94 §2
// ruling 1; mirrors the S5c-2 member-add precedent):
//   - POST duplicate → SILENT SUCCESS (BE findByPair returns existing
//     row, no audit event).
//   - DELETE 404 → SUCCESS at the consumer (intent satisfied; the
//     resource is already gone).
//   - Cross-tenant :id → 404 (D + F precheck parent; E returns empty
//     list per §7.3 cross-schema rule).

import { apiClient } from '@aramo/fe-foundation';

import type {
  AddTeamClientRequest,
  AddTeamClientResponse,
  AssignRequisitionRequest,
  AssignUserRequest,
  AssignUserResponse,
  RequisitionAssignmentListView,
  RequisitionAssignmentView,
  TeamClientOwnershipListView,
  UserClientAssignmentListView,
} from './types';

// ─── D — Company-assignments ─────────────────────────────────────────
//
// GET   /v1/companies/:companyId/assignments → {items: UserClientAssignmentRow[]}
// POST  /v1/companies/:companyId/assignments  (body: {user_id})
// DELETE /v1/companies/:companyId/assignments/:userId  (204)

export function companyAssignmentsPath(companyId: string): string {
  return `/v1/companies/${encodeURIComponent(companyId)}/assignments`;
}

export async function fetchCompanyAssignments(
  companyId: string,
): Promise<UserClientAssignmentListView> {
  return apiClient.get<UserClientAssignmentListView>(
    companyAssignmentsPath(companyId),
  );
}

export async function assignUserToCompany(args: {
  companyId: string;
  body: AssignUserRequest;
}): Promise<AssignUserResponse> {
  return apiClient.post<AssignUserResponse>(
    companyAssignmentsPath(args.companyId),
    args.body,
  );
}

export async function unassignUserFromCompany(args: {
  companyId: string;
  userId: string;
}): Promise<void> {
  return apiClient.delete<void>(
    `${companyAssignmentsPath(args.companyId)}/${encodeURIComponent(args.userId)}`,
  );
}

// ─── E — Team-clients ────────────────────────────────────────────────
//
// GET   /v1/teams/:teamId/clients → {items: TeamClientOwnershipRow[]}
// POST  /v1/teams/:teamId/clients  (body: {company_id})
// DELETE /v1/teams/:teamId/clients/:companyId  (204)

export function teamClientsPath(teamId: string): string {
  return `/v1/teams/${encodeURIComponent(teamId)}/clients`;
}

export async function fetchTeamClients(
  teamId: string,
): Promise<TeamClientOwnershipListView> {
  return apiClient.get<TeamClientOwnershipListView>(teamClientsPath(teamId));
}

export async function addTeamClient(args: {
  teamId: string;
  body: AddTeamClientRequest;
}): Promise<AddTeamClientResponse> {
  return apiClient.post<AddTeamClientResponse>(
    teamClientsPath(args.teamId),
    args.body,
  );
}

export async function removeTeamClient(args: {
  teamId: string;
  companyId: string;
}): Promise<void> {
  return apiClient.delete<void>(
    `${teamClientsPath(args.teamId)}/${encodeURIComponent(args.companyId)}`,
  );
}

// ─── F — Requisition-assign ──────────────────────────────────────────
//
// GET   /v1/requisitions/:id/assignments → {items: RequisitionAssignmentView[]}
// POST  /v1/requisitions/:id/assignments  (body: {user_id})
// DELETE /v1/requisitions/:id/assignments/:user_id  (204)

export function requisitionAssignmentsPath(requisitionId: string): string {
  return `/v1/requisitions/${encodeURIComponent(requisitionId)}/assignments`;
}

export async function fetchRequisitionAssignments(
  requisitionId: string,
): Promise<RequisitionAssignmentListView> {
  return apiClient.get<RequisitionAssignmentListView>(
    requisitionAssignmentsPath(requisitionId),
  );
}

export async function assignUserToRequisition(args: {
  requisitionId: string;
  body: AssignRequisitionRequest;
}): Promise<RequisitionAssignmentView> {
  return apiClient.post<RequisitionAssignmentView>(
    requisitionAssignmentsPath(args.requisitionId),
    args.body,
  );
}

export async function unassignUserFromRequisition(args: {
  requisitionId: string;
  userId: string;
}): Promise<void> {
  return apiClient.delete<void>(
    `${requisitionAssignmentsPath(args.requisitionId)}/${encodeURIComponent(args.userId)}`,
  );
}
