import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// AUTHZ-D4a — UserClientAssignment repository (direct-assignment axis).
//
// Mirrors RequisitionAssignment in libs/requisition. Idempotent assignment
// via composite-key findUnique (no UPDATE on re-assign — silent no-op per
// Lead Gate-5 ruling 6). user_id is a cross-schema logical reference to
// identity.User (UUID-only, no FK per Architecture §7.3); company_id is an
// intra-schema FK to Company.

export interface UserClientAssignmentRow {
  id: string;
  tenant_id: string;
  user_id: string;
  company_id: string;
  assigned_at: Date;
  assigned_by_id: string | null;
}

@Injectable()
export class UserClientAssignmentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByPair(args: {
    tenant_id: string;
    user_id: string;
    company_id: string;
  }): Promise<UserClientAssignmentRow | null> {
    const row = await this.prisma.userClientAssignment.findUnique({
      where: {
        user_id_company_id: {
          user_id: args.user_id,
          company_id: args.company_id,
        },
      },
    });
    if (row === null || row.tenant_id !== args.tenant_id) return null;
    return row as UserClientAssignmentRow;
  }

  async create(args: {
    tenant_id: string;
    user_id: string;
    company_id: string;
    assigned_by_id: string | null;
  }): Promise<UserClientAssignmentRow> {
    const row = await this.prisma.userClientAssignment.create({
      data: {
        tenant_id: args.tenant_id,
        user_id: args.user_id,
        company_id: args.company_id,
        assigned_by_id: args.assigned_by_id,
      },
    });
    return row as UserClientAssignmentRow;
  }

  async deleteByPair(args: {
    tenant_id: string;
    user_id: string;
    company_id: string;
  }): Promise<void> {
    await this.prisma.userClientAssignment.deleteMany({
      where: {
        tenant_id: args.tenant_id,
        user_id: args.user_id,
        company_id: args.company_id,
      },
    });
  }

  async findByUser(args: {
    tenant_id: string;
    user_id: string;
  }): Promise<UserClientAssignmentRow[]> {
    const rows = await this.prisma.userClientAssignment.findMany({
      where: { tenant_id: args.tenant_id, user_id: args.user_id },
    });
    return rows as UserClientAssignmentRow[];
  }

  async findByCompany(args: {
    tenant_id: string;
    company_id: string;
  }): Promise<UserClientAssignmentRow[]> {
    const rows = await this.prisma.userClientAssignment.findMany({
      where: { tenant_id: args.tenant_id, company_id: args.company_id },
    });
    return rows as UserClientAssignmentRow[];
  }
}
