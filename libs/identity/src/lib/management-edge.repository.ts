import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// AUTHZ-D4a — ManagementEdge repository (Axis-1 management hierarchy).
//
// D4a is WRITE-SIDE only — this repo creates/deletes edges + walks ancestors
// for the cycle-check on edge-create. D4b's read-side predicate also walks
// these edges to compute transitive reports up to MAX_MANAGEMENT_DEPTH=3
// (the read-side cap; edge-create has no depth cap — only cycles are
// rejected per Lead Gate-5 ruling 4).

export interface ManagementEdgeRow {
  id: string;
  tenant_id: string;
  manager_user_id: string;
  report_user_id: string;
  created_at: Date;
  created_by_id: string | null;
}

@Injectable()
export class ManagementEdgeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<ManagementEdgeRow | null> {
    const row = await this.prisma.managementEdge.findUnique({
      where: { id: args.id },
    });
    if (row === null || row.tenant_id !== args.tenant_id) return null;
    return row as ManagementEdgeRow;
  }

  async findByPair(args: {
    tenant_id: string;
    manager_user_id: string;
    report_user_id: string;
  }): Promise<ManagementEdgeRow | null> {
    const row = await this.prisma.managementEdge.findUnique({
      where: {
        manager_user_id_report_user_id: {
          manager_user_id: args.manager_user_id,
          report_user_id: args.report_user_id,
        },
      },
    });
    if (row === null || row.tenant_id !== args.tenant_id) return null;
    return row as ManagementEdgeRow;
  }

  async create(args: {
    tenant_id: string;
    manager_user_id: string;
    report_user_id: string;
    created_by_id: string | null;
  }): Promise<ManagementEdgeRow> {
    const row = await this.prisma.managementEdge.create({
      data: {
        tenant_id: args.tenant_id,
        manager_user_id: args.manager_user_id,
        report_user_id: args.report_user_id,
        created_by_id: args.created_by_id,
      },
    });
    return row as ManagementEdgeRow;
  }

  async deleteById(args: { tenant_id: string; id: string }): Promise<void> {
    await this.prisma.managementEdge.deleteMany({
      where: { id: args.id, tenant_id: args.tenant_id },
    });
  }

  // Walk UP from start_user_id collecting all ancestor (manager) user IDs.
  // Tenant-scoped. The visited set bounds traversal so a malformed graph
  // (which shouldn't exist post-cycle-check) cannot infinite-loop.
  async findAncestorUserIds(args: {
    tenant_id: string;
    start_user_id: string;
  }): Promise<Set<string>> {
    const visited = new Set<string>();
    const queue: string[] = [args.start_user_id];
    while (queue.length > 0) {
      const current = queue.shift()!;
      const edges = await this.prisma.managementEdge.findMany({
        where: { tenant_id: args.tenant_id, report_user_id: current },
        select: { manager_user_id: true },
      });
      for (const e of edges) {
        if (visited.has(e.manager_user_id)) continue;
        visited.add(e.manager_user_id);
        queue.push(e.manager_user_id);
      }
    }
    return visited;
  }

  // List all reports of a manager (direct). D4b will use a transitive
  // variant; D4a only needs this for tests.
  async findDirectReports(args: {
    tenant_id: string;
    manager_user_id: string;
  }): Promise<ManagementEdgeRow[]> {
    const rows = await this.prisma.managementEdge.findMany({
      where: { tenant_id: args.tenant_id, manager_user_id: args.manager_user_id },
    });
    return rows as ManagementEdgeRow[];
  }

  // Settings S5-BE2 — list ALL management edges in the tenant. The
  // scope-gated tenant-wide read (Reading A, PO-ratified): a holder of
  // org:manage lists every edge in the tenant — the same authority the
  // org:manage write side already grants (a POST /v1/management/edges
  // can target ANY two users in the tenant, no visibility narrowing).
  // The reads match the writes (read = write authority).
  //
  // No resolver call (Reading A). Tenant-scoped WHERE on tenant_id is
  // the only filter. Order: (created_at asc, id asc) — stable for the
  // S5c org-tree render.
  async findAllForTenant(tenant_id: string): Promise<ManagementEdgeRow[]> {
    const rows = await this.prisma.managementEdge.findMany({
      where: { tenant_id },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows as ManagementEdgeRow[];
  }

  // AUTHZ-D4b — walk DOWNWARD from a manager collecting transitive
  // report user IDs up to max_depth (default 3 per D4a Lead-ruling 4 —
  // depth applies at TRAVERSAL, not edge-creation). Excludes the
  // starting manager.
  //
  // Implemented as a depth-bounded BFS over frontiers (each iteration
  // expands one tier of reports); cap on max_depth + the visited set
  // bound a malformed graph (which the write-side cycle-check already
  // prevents — visited is a safety belt).
  async findTransitiveReportUserIds(args: {
    tenant_id: string;
    manager_user_id: string;
    max_depth?: number;
  }): Promise<Set<string>> {
    const maxDepth = args.max_depth ?? 3;
    const visited = new Set<string>();
    let frontier: string[] = [args.manager_user_id];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const edges = await this.prisma.managementEdge.findMany({
        where: {
          tenant_id: args.tenant_id,
          manager_user_id: { in: frontier },
        },
        select: { report_user_id: true },
      });
      const next: string[] = [];
      for (const e of edges) {
        if (visited.has(e.report_user_id)) continue;
        if (e.report_user_id === args.manager_user_id) continue;
        visited.add(e.report_user_id);
        next.push(e.report_user_id);
      }
      frontier = next;
    }
    return visited;
  }
}
