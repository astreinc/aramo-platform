import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { ManagementEdgeService } from './management-edge.service.js';
import type { ManagementEdgeRow } from './management-edge.repository.js';
import { TeamService } from './team.service.js';
import type { TeamMembershipRow, TeamRow } from './team.repository.js';

// AUTHZ-D4a — identity-side mechanism controller (Axis-1 hierarchy +
// Axis-2 pods). Exposes the org:manage and team:manage (identity-side)
// surfaces. The company-side mechanisms (company:assign +
// team:client_ownership) live in libs/company per the Option A
// schema-placement (mirrors the RequisitionAssignment placement —
// the join lives WITH the intra-schema-FK entity).
//
// Guard chain (verbatim A2 pattern, matches activity/company/etc):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           — class-level (tenant axis)
//   @RequireScopes(...)                 — route-level (scope axis)
@Controller('v1')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class D4aController {
  constructor(
    private readonly mgmtEdges: ManagementEdgeService,
    private readonly teams: TeamService,
  ) {}

  // --- Axis-1: management edges (org:manage) -------------------------------

  // Settings S5-BE2 — list the management edges (the org-tree).
  //
  // READING A (PO-ratified): scope-gated tenant-wide — a holder of
  // org:manage lists every edge in the tenant. The reads MATCH the
  // existing mutate authority (POST /v1/management/edges accepts ANY
  // two users in the tenant — no D4b narrowing). NO resolver call;
  // NO resolver extension; the D4b resolver logic UNCHANGED. Cf the
  // S5 charter §4 correction note (PL-85 — these aren't D4b
  // work-visibility entities; the resolver has no visible_edge_ids set;
  // §4's "NOT see-all" intent is satisfied by the explicit scope gate).
  //
  // Per-tenant isolation: the repo's WHERE filters on tenant_id which
  // derives from authContext (NEVER from a query param). The response
  // is { items: [...] } — empty for a tenant with no edges.
  @Get('management/edges')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('org:manage')
  async listEdges(
    @AuthContext() authContext: AuthContextType,
  ): Promise<{ items: ManagementEdgeRow[] }> {
    const items = await this.mgmtEdges.listAllForTenant(authContext.tenant_id);
    return { items };
  }

  @Post('management/edges')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('org:manage')
  async setEdge(
    @AuthContext() authContext: AuthContextType,
    @Body() body: { manager_user_id: string; report_user_id: string },
    @RequestId() requestId: string,
  ): Promise<{ id: string; manager_user_id: string; report_user_id: string }> {
    const row = await this.mgmtEdges.setEdge({
      tenant_id: authContext.tenant_id,
      manager_user_id: body.manager_user_id,
      report_user_id: body.report_user_id,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
    return {
      id: row.id,
      manager_user_id: row.manager_user_id,
      report_user_id: row.report_user_id,
    };
  }

  @Delete('management/edges/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('org:manage')
  async clearEdge(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.mgmtEdges.clearEdge({
      tenant_id: authContext.tenant_id,
      id,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
  }

  // --- Axis-2: teams + memberships (team:manage) ---------------------------

  // Settings S5-BE2 — list the teams (the pods).
  //
  // READING A: scope-gated tenant-wide — a holder of team:manage lists
  // every team in the tenant (active + inactive both surface; the
  // is_active field is on the row). The reads MATCH the existing mutate
  // authority (POST /v1/teams creates any team in the tenant — no D4b
  // narrowing). NO resolver call.
  @Get('teams')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('team:manage')
  async listTeams(
    @AuthContext() authContext: AuthContextType,
  ): Promise<{ items: TeamRow[] }> {
    const items = await this.teams.listAllTeamsForTenant(authContext.tenant_id);
    return { items };
  }

  // Settings S5-BE2 — list a team's memberships.
  //
  // READING A: scope-gated tenant-wide. The team:manage holder can list
  // members of ANY team in the tenant (parity with POST/DELETE
  // teams/:teamId/members which target any team). A cross-tenant
  // :teamId → 404 (the existence-non-leak rule per S5-BE1; the
  // findTeamById precheck in TeamService.listMembersForTeam returns
  // null for a cross-tenant team_id which becomes 404).
  @Get('teams/:teamId/members')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('team:manage')
  async listTeamMembers(
    @AuthContext() authContext: AuthContextType,
    @Param('teamId') teamId: string,
    @RequestId() requestId: string,
  ): Promise<{ items: TeamMembershipRow[] }> {
    const items = await this.teams.listMembersForTeam({
      tenant_id: authContext.tenant_id,
      team_id: teamId,
      request_id: requestId,
    });
    return { items };
  }

  @Post('teams')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('team:manage')
  async createTeam(
    @AuthContext() authContext: AuthContextType,
    @Body() body: { name: string; owner_user_id: string },
    @RequestId() requestId: string,
  ): Promise<{ id: string; name: string; owner_user_id: string; is_active: boolean }> {
    const row = await this.teams.createTeam({
      tenant_id: authContext.tenant_id,
      name: body.name,
      owner_user_id: body.owner_user_id,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
    return {
      id: row.id,
      name: row.name,
      owner_user_id: row.owner_user_id,
      is_active: row.is_active,
    };
  }

  @Post('teams/:teamId/members')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('team:manage')
  async addMembership(
    @AuthContext() authContext: AuthContextType,
    @Param('teamId') teamId: string,
    @Body() body: { user_id: string },
    @RequestId() requestId: string,
  ): Promise<{ id: string; team_id: string; user_id: string }> {
    const row = await this.teams.addMembership({
      tenant_id: authContext.tenant_id,
      team_id: teamId,
      user_id: body.user_id,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
    return { id: row.id, team_id: row.team_id, user_id: row.user_id };
  }

  @Delete('teams/:teamId/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('team:manage')
  async removeMembership(
    @AuthContext() authContext: AuthContextType,
    @Param('teamId') teamId: string,
    @Param('userId') userId: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.teams.removeMembership({
      tenant_id: authContext.tenant_id,
      team_id: teamId,
      user_id: userId,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
  }
}
