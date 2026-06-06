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

  // Settings S5-BE2 — list ALL teams in the tenant (active AND inactive
  // both surface; is_active is a field on the row so the FE can render
  // the distinction). The scope-gated tenant-wide read (Reading A,
  // PO-ratified): a holder of team:manage lists every team in the tenant
  // — the same authority the team:manage write side already grants
  // (a POST /v1/teams creates any team in the tenant, no visibility
  // narrowing). The reads match the writes (read = write authority).
  //
  // No resolver call (Reading A). Tenant-scoped WHERE on tenant_id is
  // the only filter. Order: (name asc, id asc) — stable for the S5c
  // team-picker render.
  async findAllTeamsForTenant(tenant_id: string): Promise<TeamRow[]> {
    const rows = await this.prisma.team.findMany({
      where: { tenant_id },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows as TeamRow[];
  }

  // AUTHZ-D4b — return the IDs of every ACTIVE team the user is a
  // member of in tenant. Used by VisibilityResolverService to resolve
  // the Axis-2 pod-clients union. Inactive teams (is_active=false) are
  // excluded — pod ownership of clients lapses when the team is
  // deactivated (Amendment §4 boundary).
  async findActiveTeamIdsForUser(args: {
    tenant_id: string;
    user_id: string;
  }): Promise<string[]> {
    const rows = await this.prisma.teamMembership.findMany({
      where: {
        tenant_id: args.tenant_id,
        user_id: args.user_id,
        team: { is_active: true },
      },
      select: { team_id: true },
    });
    return rows.map((r) => r.team_id);
  }
}
