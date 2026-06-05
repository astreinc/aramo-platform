import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// AUTHZ-D4a — TeamClientOwnership repository (Axis-2 pod -> client linkage).
//
// team_id is a cross-schema logical reference to identity.Team (UUID-only,
// no FK per Architecture §7.3); company_id is an intra-schema FK to Company.
// Idempotent ownership add (silent no-op on duplicate).

export interface TeamClientOwnershipRow {
  id: string;
  tenant_id: string;
  team_id: string;
  company_id: string;
  assigned_at: Date;
  assigned_by_id: string | null;
}

@Injectable()
export class TeamClientOwnershipRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByPair(args: {
    tenant_id: string;
    team_id: string;
    company_id: string;
  }): Promise<TeamClientOwnershipRow | null> {
    const row = await this.prisma.teamClientOwnership.findUnique({
      where: {
        team_id_company_id: {
          team_id: args.team_id,
          company_id: args.company_id,
        },
      },
    });
    if (row === null || row.tenant_id !== args.tenant_id) return null;
    return row as TeamClientOwnershipRow;
  }

  async create(args: {
    tenant_id: string;
    team_id: string;
    company_id: string;
    assigned_by_id: string | null;
  }): Promise<TeamClientOwnershipRow> {
    const row = await this.prisma.teamClientOwnership.create({
      data: {
        tenant_id: args.tenant_id,
        team_id: args.team_id,
        company_id: args.company_id,
        assigned_by_id: args.assigned_by_id,
      },
    });
    return row as TeamClientOwnershipRow;
  }

  async deleteByPair(args: {
    tenant_id: string;
    team_id: string;
    company_id: string;
  }): Promise<void> {
    await this.prisma.teamClientOwnership.deleteMany({
      where: {
        tenant_id: args.tenant_id,
        team_id: args.team_id,
        company_id: args.company_id,
      },
    });
  }

  async findByTeam(args: {
    tenant_id: string;
    team_id: string;
  }): Promise<TeamClientOwnershipRow[]> {
    const rows = await this.prisma.teamClientOwnership.findMany({
      where: { tenant_id: args.tenant_id, team_id: args.team_id },
    });
    return rows as TeamClientOwnershipRow[];
  }
}
