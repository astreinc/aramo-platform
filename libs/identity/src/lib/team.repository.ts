import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// AUTHZ-D4a — TeamRepository (Axis-2 account-ownership pods).
//
// Stores Team (the pod) + TeamMembership (the user ↔ pod join). The
// company-side TeamClientOwnership join lives in libs/company per the
// Option A schema placement.

export interface TeamRow {
  id: string;
  tenant_id: string;
  name: string;
  owner_user_id: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TeamMembershipRow {
  id: string;
  tenant_id: string;
  team_id: string;
  user_id: string;
  added_at: Date;
  added_by_id: string | null;
}

@Injectable()
export class TeamRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findTeamById(args: {
    tenant_id: string;
    id: string;
  }): Promise<TeamRow | null> {
    const row = await this.prisma.team.findUnique({ where: { id: args.id } });
    if (row === null || row.tenant_id !== args.tenant_id) return null;
    return row as TeamRow;
  }

  async findTeamByName(args: {
    tenant_id: string;
    name: string;
  }): Promise<TeamRow | null> {
    const row = await this.prisma.team.findUnique({
      where: { tenant_id_name: { tenant_id: args.tenant_id, name: args.name } },
    });
    return row as TeamRow | null;
  }

  async createTeam(args: {
    tenant_id: string;
    name: string;
    owner_user_id: string;
  }): Promise<TeamRow> {
    const row = await this.prisma.team.create({
      data: {
        tenant_id: args.tenant_id,
        name: args.name,
        owner_user_id: args.owner_user_id,
        is_active: true,
      },
    });
    return row as TeamRow;
  }

  async findMembership(args: {
    tenant_id: string;
    team_id: string;
    user_id: string;
  }): Promise<TeamMembershipRow | null> {
    const row = await this.prisma.teamMembership.findUnique({
      where: {
        team_id_user_id: { team_id: args.team_id, user_id: args.user_id },
      },
    });
    if (row === null || row.tenant_id !== args.tenant_id) return null;
    return row as TeamMembershipRow;
  }

  async addMembership(args: {
    tenant_id: string;
    team_id: string;
    user_id: string;
    added_by_id: string | null;
  }): Promise<TeamMembershipRow> {
    const row = await this.prisma.teamMembership.create({
      data: {
        tenant_id: args.tenant_id,
        team_id: args.team_id,
        user_id: args.user_id,
        added_by_id: args.added_by_id,
      },
    });
    return row as TeamMembershipRow;
  }

  async removeMembership(args: {
    tenant_id: string;
    team_id: string;
    user_id: string;
  }): Promise<void> {
    await this.prisma.teamMembership.deleteMany({
      where: {
        tenant_id: args.tenant_id,
        team_id: args.team_id,
        user_id: args.user_id,
      },
    });
  }

  async findMembershipsForUser(args: {
    tenant_id: string;
    user_id: string;
  }): Promise<TeamMembershipRow[]> {
    const rows = await this.prisma.teamMembership.findMany({
      where: { tenant_id: args.tenant_id, user_id: args.user_id },
    });
    return rows as TeamMembershipRow[];
  }

  async findMembershipsForTeam(args: {
    tenant_id: string;
    team_id: string;
  }): Promise<TeamMembershipRow[]> {
    const rows = await this.prisma.teamMembership.findMany({
      where: { tenant_id: args.tenant_id, team_id: args.team_id },
    });
    return rows as TeamMembershipRow[];
  }
}
