import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import {
  ManagementEdgeRepository,
  type ManagementEdgeRow,
} from './management-edge.repository.js';

// AUTHZ-D4a — ManagementEdgeService (Axis-1 management hierarchy).
//
// Cycle prevention (Lead Gate-5 ruling 4): edge-create rejects edges that
// would create a cycle. To detect, walk UP from the proposed manager_user_id
// (find its ancestors via existing edges); if the proposed report_user_id
// appears in the ancestor set, the new edge would close the loop
// (report -> ... -> manager -> report). Self-loops are also rejected.
//
// Depth cap (Lead Gate-5 ruling 4): NOT enforced at edge-create. An org may
// have a deeper reporting chain than the visibility cap. D4b's traversal
// stops at MAX_MANAGEMENT_DEPTH (3) when computing transitive visibility.
@Injectable()
export class ManagementEdgeService {
  constructor(
    private readonly repo: ManagementEdgeRepository,
    private readonly audit: IdentityAuditService,
  ) {}

  async setEdge(args: {
    tenant_id: string;
    manager_user_id: string;
    report_user_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<ManagementEdgeRow> {
    // Reject self-loops (degenerate cycle).
    if (args.manager_user_id === args.report_user_id) {
      throw new AramoError(
        'MANAGEMENT_CYCLE_REJECTED',
        'A user cannot manage themselves',
        409,
        {
          requestId: args.request_id,
          details: {
            manager_user_id: args.manager_user_id,
            report_user_id: args.report_user_id,
            reason: 'self_loop',
          },
        },
      );
    }
    // Idempotent: if the edge already exists, return it (no-op + no event).
    const existing = await this.repo.findByPair({
      tenant_id: args.tenant_id,
      manager_user_id: args.manager_user_id,
      report_user_id: args.report_user_id,
    });
    if (existing !== null) return existing;

    // Cycle check: walk UP from manager_user_id. If report_user_id is an
    // ancestor of manager, the new edge would form a cycle.
    const ancestors = await this.repo.findAncestorUserIds({
      tenant_id: args.tenant_id,
      start_user_id: args.manager_user_id,
    });
    if (ancestors.has(args.report_user_id)) {
      throw new AramoError(
        'MANAGEMENT_CYCLE_REJECTED',
        'The proposed management edge would create a cycle in the management graph',
        409,
        {
          requestId: args.request_id,
          details: {
            manager_user_id: args.manager_user_id,
            report_user_id: args.report_user_id,
            reason: 'cycle',
          },
        },
      );
    }

    const row = await this.repo.create({
      tenant_id: args.tenant_id,
      manager_user_id: args.manager_user_id,
      report_user_id: args.report_user_id,
      created_by_id: args.actor_user_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.management_edge.set',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: row.id,
      payload: {
        manager_user_id: args.manager_user_id,
        report_user_id: args.report_user_id,
      },
    });
    return row;
  }

  // Settings S5-BE2 — list every management edge in the tenant. Reading A
  // (scope-gated tenant-wide): the controller's org:manage gate is the
  // only authority check; this pass-through reads tenant-scoped from the
  // repo. No resolver call.
  async listAllForTenant(tenant_id: string): Promise<ManagementEdgeRow[]> {
    return this.repo.findAllForTenant(tenant_id);
  }

  async clearEdge(args: {
    tenant_id: string;
    id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<void> {
    const existing = await this.repo.findById({
      tenant_id: args.tenant_id,
      id: args.id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Management edge not found in tenant',
        404,
        { requestId: args.request_id, details: { id: args.id } },
      );
    }
    await this.repo.deleteById({ tenant_id: args.tenant_id, id: args.id });
    await this.audit.writeEvent({
      event_type: 'identity.management_edge.cleared',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: args.id,
      payload: {
        manager_user_id: existing.manager_user_id,
        report_user_id: existing.report_user_id,
      },
    });
  }
}
