// Settings S5c-1 — hand-mirrored types for the org-hierarchy surface.
//
// Mirror sources (NO @aramo/* import — apps/tenant-console stays a leaf
// consumer of the HTTP surface; the FE-isolation rule from S5a/S5b):
//   - ManagementEdgeRow: libs/identity/src/lib/management-edge.repository.ts
//   - User-roster row reuses users/types.TenantUserView (same app, no
//     cross-workspace import — the existing S5b mirror).

import type { TenantUserView } from '../users/types';

// ─── ManagementEdgeRow (D4a + S5-BE2) ────────────────────────────────
//
// The flat edge shape returned by GET /v1/management/edges. The BE row
// carries `tenant_id` + `created_at` (ISO string in the JSON payload) +
// `created_by_id`; the FE Tree only NEEDS `id` + `manager_user_id` +
// `report_user_id` to synthesize the hierarchy, but we mirror the full
// shape for honesty (and so a future surface that needs them does not
// re-add fields).
export interface ManagementEdgeRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly manager_user_id: string;
  readonly report_user_id: string;
  readonly created_at: string;
  readonly created_by_id: string | null;
}

export interface ManagementEdgeListView {
  readonly items: readonly ManagementEdgeRow[];
}

// ─── Add-edge payload shapes ─────────────────────────────────────────

export interface AddEdgeRequest {
  readonly manager_user_id: string;
  readonly report_user_id: string;
}

export interface AddEdgeResponse {
  readonly id: string;
  readonly manager_user_id: string;
  readonly report_user_id: string;
}

// ─── Tree-node types ─────────────────────────────────────────────────
//
// The FE synthesizes the management hierarchy from the flat edge list +
// the user roster. The Tree component renders nodes recursively.
//
// MULTI-PARENT RULING (PL-94 §2 ruling 2): the edge schema permits a
// user to report to multiple managers (a DAG). Each appearance of a
// user under a parent is a SEPARATE node-instance, keyed by the EDGE id
// (one edge ⇒ one render). Root users (no incoming edge) are keyed by
// their user_id.
export interface TreeNode {
  // Unique render key. For a root, this is `root:${user_id}`. For a
  // report node, this is the edge_id (one edge ⇒ one render). This
  // gives stable React keys AND lets the DOM id stay unique even when
  // the same user appears under multiple parents.
  readonly key: string;
  // The underlying user — null when the synthesizer cannot find a
  // matching row (e.g. an edge references a user the FE-visible roster
  // does not include; the 403 fallback case).
  readonly user: TenantUserView | null;
  // The raw user_id from the edge (or from the roster for a root).
  // Always present, even when `user` is null.
  readonly user_id: string;
  // The originating edge_id, when this node was created by an edge.
  // null for a root.
  readonly edge_id: string | null;
  // The parent's user_id (for aria-label disambiguation). null for a
  // root.
  readonly parent_user_id: string | null;
  // Direct reports under this node.
  readonly children: readonly TreeNode[];
  // PL-94 §2 ruling 3 — depth-defense flags:
  // - `depth_capped`: the synthesizer stopped at the soft cap (10) and
  //   any further descendants are collapsed under a "Show more…"
  //   expander surfaced by the caller.
  // - `cycle_skipped`: the per-path visited-set caught a revisit (the
  //   BE should prevent this, but defense-in-depth — never infinite-
  //   render). When true, the node has no children (already-rendered).
  readonly depth_capped: boolean;
  readonly cycle_skipped: boolean;
}

// PL-94 §2 ruling 3 — the soft RENDER-UX cap (NOT the BE's D4b
// MAX_MANAGEMENT_DEPTH=3 visibility cap; an unrelated concern).
export const TREE_DEPTH_SOFT_CAP = 10;

// ─── Edge-rejection details (the load-bearing surface) ───────────────
//
// The BE rejects invalid edges with MANAGEMENT_CYCLE_REJECTED (HTTP
// 409, libs/common error-codes.ts:308). The error.details.reason is
// 'self_loop' OR 'cycle' — the FE renders these legibly (the S5b
// error-message precedent). Duplicates are IDEMPOTENT successes at the
// BE (findByPair returns existing row, no audit event) — the FE does
// NOT treat them as errors (PL-94 §2 ruling 4).
export type EdgeRejectionReason = 'self_loop' | 'cycle';

// ─── Picker-source probe outcome (Settings S5c-2 ruling 7) ───────────
//
// `UserRosterState` and its probe now live in users/users-api.ts (the
// shared S5c-1 + S5c-2 + S5c-3 surface). org/edges-api.ts re-exports
// the type for back-compatible imports from the org/* module.
export type { UserRosterState } from '../users/users-api';
