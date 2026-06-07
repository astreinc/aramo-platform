// Settings S5c-2 — teams + members HTTP client.
//
// Wires the existing endpoints (S5-BE2 reads + D4a mutates); S5c-2
// adds no backend route.

import { apiClient } from '../api/client';

import type {
  AddMemberRequest,
  AddMemberResponse,
  CreateTeamRequest,
  CreateTeamResponse,
  TeamListView,
  TeamMembershipListView,
} from './types';

export const TEAMS_PATH = '/v1/teams';

// GET /v1/teams — the tenant's teams (Reading A; tenant-wide).
export async function fetchTeams(): Promise<TeamListView> {
  return apiClient.get<TeamListView>(TEAMS_PATH);
}

// GET /v1/teams/:teamId/members — a team's memberships.
//
// A 404 (cross-tenant teamId, or unknown id) is propagated as ApiError;
// the caller renders the "this team isn't in your tenant" message.
export async function fetchTeamMembers(
  teamId: string,
): Promise<TeamMembershipListView> {
  return apiClient.get<TeamMembershipListView>(
    `${TEAMS_PATH}/${encodeURIComponent(teamId)}/members`,
  );
}

// POST /v1/teams — create a team.
//
// REJECTED with 400 VALIDATION_ERROR on duplicate name (PL-94 §2 ruling
// 6; NOT idempotent — a duplicate name is a genuine collision, unlike
// a duplicate membership which is a no-op). The BE supplies
// `details: {name, existing_team_id}` for the legible mapper.
export async function createTeam(
  body: CreateTeamRequest,
): Promise<CreateTeamResponse> {
  return apiClient.post<CreateTeamResponse>(TEAMS_PATH, body);
}

// POST /v1/teams/:teamId/members — add a member.
//
// IDEMPOTENT at the BE (PL-94 §2 ruling 6 — the S5c-1 edge precedent):
// a duplicate (team, user) pair returns the existing row with 201, no
// audit event. The FE NEVER surfaces a duplicate as error.
export async function addMember(args: {
  teamId: string;
  body: AddMemberRequest;
}): Promise<AddMemberResponse> {
  return apiClient.post<AddMemberResponse>(
    `${TEAMS_PATH}/${encodeURIComponent(args.teamId)}/members`,
    args.body,
  );
}

// DELETE /v1/teams/:teamId/members/:userId — remove a member.
//
// A 404 means the membership is already gone — the caller treats this
// as success (PL-94 §2 ruling 6; intent satisfied).
export async function removeMember(args: {
  teamId: string;
  userId: string;
}): Promise<void> {
  return apiClient.delete<void>(
    `${TEAMS_PATH}/${encodeURIComponent(args.teamId)}/members/${encodeURIComponent(args.userId)}`,
  );
}
