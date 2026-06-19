// Settings S5c-2 — hand-mirrored types for the teams + members surface.
//
// Mirror sources (NO @aramo/* import — apps/tenant-console stays a leaf
// consumer of the HTTP surface; the FE-isolation rule from S5a/S5b):
//   - TeamRow: libs/identity/src/lib/team.repository.ts
//   - TeamMembershipRow: libs/identity/src/lib/team.repository.ts
//   - User-roster row reuses users/types.TenantUserView (same app).

// ─── TeamRow (S5-BE2 + D4a) ──────────────────────────────────────────
//
// The BE row carries Date fields on its TS side; the JSON wire encodes
// them as ISO strings. We mirror the wire shape.
//
// `member_count` is NOT on this row (PL-94 §2 ruling 4 — omitted from
// the teams list; a follow-up). The teams list shows name / owner /
// status / actions; the members editor shows the count derived from
// GET /v1/teams/:teamId/members.
export interface TeamRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly name: string;
  readonly owner_user_id: string;
  readonly is_active: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TeamListView {
  readonly items: readonly TeamRow[];
}

// ─── TeamMembershipRow (S5-BE2 + D4a) ────────────────────────────────
//
// NO user-info join at the BE — just `user_id`. The FE joins with the
// roster client-side (users/users-api.probeUserRoster — the shared
// roster-probe).
export interface TeamMembershipRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly team_id: string;
  readonly user_id: string;
  readonly added_at: string;
  readonly added_by_id: string | null;
}

export interface TeamMembershipListView {
  readonly items: readonly TeamMembershipRow[];
}

// ─── Create-team payload shapes ──────────────────────────────────────

export interface CreateTeamRequest {
  readonly name: string;
  readonly owner_user_id: string;
}

export interface CreateTeamResponse {
  readonly id: string;
  readonly name: string;
  readonly owner_user_id: string;
  readonly is_active: boolean;
}

// ─── Add-member payload shapes ───────────────────────────────────────

export interface AddMemberRequest {
  readonly user_id: string;
}

export interface AddMemberResponse {
  readonly id: string;
  readonly team_id: string;
  readonly user_id: string;
}
