import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, hashCanonicalizedBody, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { IdempotencyService } from '@aramo/consent';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { CommunicationsApiService } from './communications-api.service.js';
import { CommunicationCallService } from './communication-call.service.js';
import { InitiateCommunicationCallDto, UpsertProviderIdentityDto } from './dto/communications.dto.js';
import type {
  CommunicationCapabilitiesDto,
  CommunicationInteractionViewDto,
  CommunicationProviderIdentityDto,
  CommunicationProviderIdentityListDto,
} from './dto/communications.dto.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  constructor(
    private readonly comms: CommunicationsApiService,
    private readonly calls: CommunicationCallService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // COMM-B5 — initiate an outbound voice call. communication:voice:call scope
  // (least-visibility) + a required Idempotency-Key (call initiation has an
  // external side effect and must not dial twice on retry). The fail-closed
  // contacting-consent gate + the locked execution order live in the service;
  // the controller owns the platform idempotency replay/conflict envelope.
  @Post('calls')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('communication:voice:call')
  async initiateCall(
    @Body() dto: InitiateCommunicationCallDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationInteractionViewDto> {
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    const requestHash = hashCanonicalizedBody(dto as unknown);
    const lookup = await this.idempotency.lookup({
      tenant_id: auth.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as CommunicationInteractionViewDto;
    }
    const view = await this.calls.initiate(auth, dto, requestId);
    await this.idempotency.persist({
      tenant_id: auth.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.CREATED,
      response_body: view,
    });
    return view;
  }

  private assertIdempotencyKeyRequired(idempotencyKey: string | undefined, requestId: string): string {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key header is required', 400, {
        requestId,
        details: { missing_field: 'Idempotency-Key' },
      });
    }
    if (!UUID_REGEX.test(idempotencyKey)) {
      throw new AramoError('VALIDATION_ERROR', 'Idempotency-Key must be a UUID', 400, {
        requestId,
        details: { invalid_field: 'Idempotency-Key' },
      });
    }
    return idempotencyKey;
  }

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

  // COMM-B3 — provider-identity mapping ADMIN. Authorized by integration:*
  // (configuring the tenant's provider integration), NOT communication:*: mapping
  // a recruiter to a Zoom user is an administrative provider-configuration act.
  // The recruiter's OWN read (me/provider-identity, above) stays communication:read.
  @Get('provider-identities')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async listProviderIdentities(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationProviderIdentityListDto> {
    const items = await this.comms.listProviderIdentities(auth.tenant_id, requestId);
    return { items };
  }

  @Put('provider-identities/:recruiterId')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async upsertProviderIdentity(
    @Param('recruiterId', ParseUUIDPipe) recruiterId: string,
    @Body() dto: UpsertProviderIdentityDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationProviderIdentityDto> {
    return this.comms.upsertProviderIdentity(auth.tenant_id, recruiterId, dto, requestId);
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
