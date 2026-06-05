import {
  Body,
  Controller,
  Delete,
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
