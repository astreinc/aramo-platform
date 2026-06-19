// Settings S5c-1 — pure-function tree synthesis (testable in isolation).
//
// Inputs:
//   - edges: a FLAT list from GET /v1/management/edges
//   - users: the user roster from GET /v1/tenant/users (or [] when the
//     403 fallback is in effect — in which case nodes carry null user
//     and the FE displays the user_id verbatim)
//
// Output:
//   - roots: TreeNode[] — the top-level nodes (users with NO incoming
//     edge). When a user has 0 incoming edges AND 0 outgoing edges,
//     they still appear as a single root (a standalone person).
//
// MULTI-PARENT (PL-94 §2 ruling 2): a user with N incoming edges
// appears N times — once under each parent. Roots are keyed by
// `root:${user_id}`; reports are keyed by their incoming edge_id.
//
// DEPTH-DEFENSE (PL-94 §2 ruling 3): a per-PATH visited set catches
// data anomalies (the BE prevents cycles, but defense-in-depth); a
// soft RENDER-UX cap stops recursion at TREE_DEPTH_SOFT_CAP, after
// which children are collapsed under a "Show more…" expander surfaced
// by the renderer via the `depth_capped` flag.

import type { TenantUserView } from '../assignments/roster';

import { TREE_DEPTH_SOFT_CAP, type ManagementEdgeRow, type TreeNode } from './types';

interface SynthInput {
  readonly edges: readonly ManagementEdgeRow[];
  readonly users: readonly TenantUserView[];
  // Test seam — override the soft cap. Default is TREE_DEPTH_SOFT_CAP.
  readonly depthCap?: number;
}

export interface SynthesisResult {
  readonly roots: readonly TreeNode[];
  // Diagnostic counters — used by the renderer for any "X depth-capped /
  // Y cycle-skipped" footer hint. Currently informational; the renderer
  // can surface these in the empty/edge-case helper copy.
  readonly stats: {
    readonly depth_capped_count: number;
    readonly cycle_skipped_count: number;
  };
}

export function synthesizeTree(input: SynthInput): SynthesisResult {
  const depthCap = input.depthCap ?? TREE_DEPTH_SOFT_CAP;

  const userById = new Map<string, TenantUserView>();
  for (const u of input.users) userById.set(u.user_id, u);

  // adjacency: manager_user_id → edges[]
  // Multi-parent / multi-report both naturally fall out as multiple
  // entries in this map.
  const childrenByManager = new Map<string, ManagementEdgeRow[]>();
  const reportUserIds = new Set<string>();
  for (const edge of input.edges) {
    const list = childrenByManager.get(edge.manager_user_id) ?? [];
    list.push(edge);
    childrenByManager.set(edge.manager_user_id, list);
    reportUserIds.add(edge.report_user_id);
  }

  // Roots = users known to the roster who have NO incoming edge.
  // When the user-roster is empty (the 403 fallback), we still need
  // roots: synthesize roots from manager_user_ids that never appear as
  // a report_user_id (the BE has the same shape). The roster is the
  // preferred source because it carries names AND captures lone users
  // (no edges at all).
  const rootUserIds: string[] = [];
  if (input.users.length > 0) {
    for (const u of input.users) {
      if (!reportUserIds.has(u.user_id)) rootUserIds.push(u.user_id);
    }
  } else {
    // 403-fallback path: derive root user_ids from edges only.
    const allManagers = new Set<string>();
    for (const e of input.edges) allManagers.add(e.manager_user_id);
    for (const m of allManagers) {
      if (!reportUserIds.has(m)) rootUserIds.push(m);
    }
  }
  rootUserIds.sort();

  let depthCappedCount = 0;
  let cycleSkippedCount = 0;

  function buildNode(args: {
    key: string;
    user_id: string;
    edge_id: string | null;
    parent_user_id: string | null;
    depth: number;
    visited: ReadonlySet<string>;
  }): TreeNode {
    const u = userById.get(args.user_id) ?? null;

    // Cycle defense (the BE prevents this — kept as defense-in-depth).
    if (args.visited.has(args.user_id)) {
      cycleSkippedCount++;
      return {
        key: args.key,
        user: u,
        user_id: args.user_id,
        edge_id: args.edge_id,
        parent_user_id: args.parent_user_id,
        children: [],
        depth_capped: false,
        cycle_skipped: true,
      };
    }

    // Soft depth cap (the render-UX guard — NOT the BE's D4b cap).
    if (args.depth >= depthCap) {
      const directChildEdges = childrenByManager.get(args.user_id) ?? [];
      if (directChildEdges.length > 0) {
        depthCappedCount++;
        return {
          key: args.key,
          user: u,
          user_id: args.user_id,
          edge_id: args.edge_id,
          parent_user_id: args.parent_user_id,
          children: [],
          depth_capped: true,
          cycle_skipped: false,
        };
      }
    }

    const nextVisited = new Set(args.visited);
    nextVisited.add(args.user_id);

    const childEdges = childrenByManager.get(args.user_id) ?? [];
    // Stable order: by created_at if present, else by id — matches
    // the BE's findAllForTenant orderBy.
    const sortedChildren = [...childEdges].sort((a, b) => {
      if (a.created_at !== b.created_at)
        return a.created_at < b.created_at ? -1 : 1;
      return a.id < b.id ? -1 : 1;
    });

    const children = sortedChildren.map((edge) =>
      buildNode({
        key: edge.id,
        user_id: edge.report_user_id,
        edge_id: edge.id,
        parent_user_id: args.user_id,
        depth: args.depth + 1,
        visited: nextVisited,
      }),
    );

    return {
      key: args.key,
      user: u,
      user_id: args.user_id,
      edge_id: args.edge_id,
      parent_user_id: args.parent_user_id,
      children,
      depth_capped: false,
      cycle_skipped: false,
    };
  }

  const roots = rootUserIds.map((uid) =>
    buildNode({
      key: `root:${uid}`,
      user_id: uid,
      edge_id: null,
      parent_user_id: null,
      depth: 0,
      visited: new Set<string>(),
    }),
  );

  return {
    roots,
    stats: {
      depth_capped_count: depthCappedCount,
      cycle_skipped_count: cycleSkippedCount,
    },
  };
}
