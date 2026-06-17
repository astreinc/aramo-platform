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

import { D4aCompanyService } from './d4a.service.js';
import type { TeamClientOwnershipRow } from './team-client-ownership.repository.js';
import type { UserClientAssignmentRow } from './user-client-assignment.repository.js';

// AUTHZ-D4a — company-side mechanism controller. Hosts the
// direct-assignment mechanism (company:assign) and the Axis-2 client-
// ownership mechanism (team:manage, company-side). The identity-side
// mechanisms (management edges + Team + TeamMembership) live in
// libs/identity per Option A schema placement.
@Controller('v1')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class D4aCompanyController {
  constructor(private readonly d4a: D4aCompanyService) {}

  // --- Direct-assignment (company:assign) ----------------------------------

  // Settings S5-BE2 — list a company's user assignments.
  //
  // READING A (PO-ratified): scope-gated tenant-wide — a holder of
  // company:assign lists every assignment for the company (parity with
  // POST/DELETE /v1/companies/:companyId/assignments which target any
  // company in the tenant; no D4b visible_client_ids narrowing on the
  // write side). The reads MATCH the existing mutate authority. NO
  // resolver call; NO resolver extension; the D4b resolver logic
  // UNCHANGED. Cf the S5 charter §4 correction note (PL-85).
  //
  // Cross-tenant :companyId → 404 (existence-non-leak per S5-BE1;
  // companyRepo.findById tenant-scoped precheck in
  // listAssignmentsForCompany).
  @Get('companies/:companyId/assignments')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:assign')
  async listCompanyAssignments(
    @AuthContext() authContext: AuthContextType,
    @Param('companyId') companyId: string,
    @RequestId() requestId: string,
  ): Promise<{ items: UserClientAssignmentRow[] }> {
    const items = await this.d4a.listAssignmentsForCompany({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
      request_id: requestId,
    });
    return { items };
  }

  // Phase 4 — the recruiter-readable account team (company:read). Returns the
  // account owner + assigned-member user ids so the account hub can render the
  // team card without the company:assign mechanism scope. Cross-tenant → 404.
  @Get('companies/:companyId/team')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('company:read')
  async getCompanyTeam(
    @AuthContext() authContext: AuthContextType,
    @Param('companyId') companyId: string,
    @RequestId() requestId: string,
  ): Promise<{ owner_id: string | null; member_user_ids: string[] }> {
    return this.d4a.getTeamForCompany({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
      request_id: requestId,
    });
  }

  @Post('companies/:companyId/assignments')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('company:assign')
  async assignUser(
    @AuthContext() authContext: AuthContextType,
    @Param('companyId') companyId: string,
    @Body() body: { user_id: string },
    @RequestId() requestId: string,
  ): Promise<{ id: string; user_id: string; company_id: string }> {
    const row = await this.d4a.assignUserToClient({
      tenant_id: authContext.tenant_id,
      user_id: body.user_id,
      company_id: companyId,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
    return {
      id: row.id,
      user_id: row.user_id,
      company_id: row.company_id,
    };
  }

  @Delete('companies/:companyId/assignments/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('company:assign')
  async unassignUser(
    @AuthContext() authContext: AuthContextType,
    @Param('companyId') companyId: string,
    @Param('userId') userId: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.d4a.unassignUserFromClient({
      tenant_id: authContext.tenant_id,
      user_id: userId,
      company_id: companyId,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
  }

  // --- Axis-2 client-ownership (team:manage, company-side) -----------------

  // Settings S5-BE2 — list a team's client ownerships.
  //
  // READING A: scope-gated tenant-wide. The team:manage holder lists
  // every team-client edge for the team in the tenant (parity with
  // POST/DELETE /v1/teams/:teamId/clients).
  //
  // NO team-existence precheck (the §7.3 cross-schema rule preserved
  // from addClientOwnership: Team lives in identity; this controller
  // does not impose a cross-schema FK lookup). The TeamClientOwnership
  // WHERE on tenant_id is sufficient — a cross-tenant :teamId yields an
  // empty list (no leak; indistinguishable from a tenant-local team with
  // no clients). NO resolver call.
  @Get('teams/:teamId/clients')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('team:manage')
  async listTeamClients(
    @AuthContext() authContext: AuthContextType,
    @Param('teamId') teamId: string,
  ): Promise<{ items: TeamClientOwnershipRow[] }> {
    const items = await this.d4a.listClientsForTeam({
      tenant_id: authContext.tenant_id,
      team_id: teamId,
    });
    return { items };
  }

  @Post('teams/:teamId/clients')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('team:manage')
  async addClientOwnership(
    @AuthContext() authContext: AuthContextType,
    @Param('teamId') teamId: string,
    @Body() body: { company_id: string },
    @RequestId() requestId: string,
  ): Promise<{ id: string; team_id: string; company_id: string }> {
    const row = await this.d4a.addClientOwnership({
      tenant_id: authContext.tenant_id,
      team_id: teamId,
      company_id: body.company_id,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
    return {
      id: row.id,
      team_id: row.team_id,
      company_id: row.company_id,
    };
  }

  @Delete('teams/:teamId/clients/:companyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('team:manage')
  async removeClientOwnership(
    @AuthContext() authContext: AuthContextType,
    @Param('teamId') teamId: string,
    @Param('companyId') companyId: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.d4a.removeClientOwnership({
      tenant_id: authContext.tenant_id,
      team_id: teamId,
      company_id: companyId,
      actor_user_id: authContext.sub,
      request_id: requestId,
    });
  }
}
