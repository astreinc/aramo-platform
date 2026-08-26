import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { CommunicationsApiService } from './communications-api.service.js';
import type {
  CommunicationCapabilitiesDto,
  CommunicationInteractionViewDto,
  CommunicationProviderIdentityDto,
} from './dto/communications.dto.js';

// COMM-B2 (Aramo-COMM-V1) — the read/authorization contract skeleton for the
// Communications/Voice surface. THREE read routes only; call initiation
// (POST /calls, B5) and disposition/timeline (B7) land in later slices.
//
// Three-axis authorization (mirrors integration.controller.ts): tenant axis
// EntitlementGuard + @RequireCapability('ats'); identity axis JwtAuthGuard;
// scope axis @RequireScopes. All read routes ride `communication:read`. Every
// query is tenant-scoped from the AuthContext (never the body/path).
@Controller('v1/communications')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class CommunicationsController {
  constructor(private readonly comms: CommunicationsApiService) {}

  @Get('capabilities')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async capabilities(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationCapabilitiesDto> {
    return this.comms.getCapabilities(auth.tenant_id, requestId);
  }

  @Get('me/provider-identity')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async myProviderIdentity(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationProviderIdentityDto> {
    return this.comms.getMyProviderIdentity(auth.tenant_id, auth.sub, requestId);
  }

  @Get('interactions/:interactionId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async interaction(
    @Param('interactionId', ParseUUIDPipe) interactionId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationInteractionViewDto> {
    const view = await this.comms.getInteraction(auth.tenant_id, interactionId);
    if (view === null) {
      throw new AramoError(
        'COMMUNICATION_INTERACTION_NOT_FOUND',
        'Communication interaction not found in tenant',
        404,
        { requestId, details: { interaction_id: interactionId } },
      );
    }
    return view;
  }
}
