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
}
