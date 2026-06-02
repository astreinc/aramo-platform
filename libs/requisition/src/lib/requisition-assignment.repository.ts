import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { RequisitionAssignmentView } from './dto/requisition-assignment.view.js';
import { PrismaService } from './prisma/prisma.service.js';

interface RequisitionAssignmentRow {
  id: string;
  tenant_id: string;
  requisition_id: string;
  user_id: string;
  assigned_at: Date;
  assigned_by_id: string | null;
}

function projectView(
  row: RequisitionAssignmentRow,
): RequisitionAssignmentView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    requisition_id: row.requisition_id,
    user_id: row.user_id,
    assigned_at: row.assigned_at.toISOString(),
    assigned_by_id: row.assigned_by_id,
  };
}

@Injectable()
export class RequisitionAssignmentRepository {
  private readonly logger = new Logger(RequisitionAssignmentRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create or no-op an assignment row (Ruling 1 — idempotent on the
   * (requisition_id, user_id) unique constraint). Returns the existing
   * row when present.
   */
  async assign(args: {
    tenant_id: string;
    requisition_id: string;
    user_id: string;
    assigned_by_id: string;
    requestId: string;
  }): Promise<RequisitionAssignmentView> {
    // Tenant-scoped parent existence check. The intra-schema FK would
    // catch a non-existent requisition_id, but it cannot catch a
    // cross-tenant id (the FK does not include tenant_id). Belt-and-
    // suspenders.
    const parent = await this.prisma.requisition.findFirst({
      where: { tenant_id: args.tenant_id, id: args.requisition_id },
      select: { id: true },
    });
    if (parent === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Requisition not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: { requisition_id: args.requisition_id },
        },
      );
    }

    const existing = await this.prisma.requisitionAssignment.findUnique({
      where: {
        requisition_id_user_id: {
          requisition_id: args.requisition_id,
          user_id: args.user_id,
        },
      },
    });
    if (existing !== null) {
      return projectView(existing as RequisitionAssignmentRow);
    }
    const row = await this.prisma.requisitionAssignment.create({
      data: {
        tenant_id: args.tenant_id,
        requisition_id: args.requisition_id,
        user_id: args.user_id,
        assigned_by_id: args.assigned_by_id,
      },
    });
    return projectView(row as RequisitionAssignmentRow);
  }

  /**
   * Delete an assignment row. 404 when no row exists for the
   * (requisition_id, user_id) pair in this tenant.
   */
  async unassign(args: {
    tenant_id: string;
    requisition_id: string;
    user_id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.prisma.requisitionAssignment.findFirst({
      where: {
        tenant_id: args.tenant_id,
        requisition_id: args.requisition_id,
        user_id: args.user_id,
      },
      select: { id: true },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'RequisitionAssignment not found in tenant',
        404,
        {
          requestId: args.requestId,
          details: {
            requisition_id: args.requisition_id,
            user_id: args.user_id,
          },
        },
      );
    }
    await this.prisma.requisitionAssignment.delete({
      where: { id: existing.id },
    });
  }

  async listForRequisition(args: {
    tenant_id: string;
    requisition_id: string;
  }): Promise<RequisitionAssignmentView[]> {
    const rows = await this.prisma.requisitionAssignment.findMany({
      where: {
        tenant_id: args.tenant_id,
        requisition_id: args.requisition_id,
      },
      orderBy: { assigned_at: 'desc' },
    });
    return (rows as RequisitionAssignmentRow[]).map(projectView);
  }
}
