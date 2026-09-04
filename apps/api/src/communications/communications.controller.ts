import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, hashCanonicalizedBody, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import type { ZoomCredentialBundle } from '@aramo/communications';
import { IdempotencyService } from '@aramo/consent';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import { CommunicationsApiService } from './communications-api.service.js';
import { CommunicationCallService } from './communication-call.service.js';
import { CommunicationTimelineService } from './communication-timeline.service.js';
import { AttachProviderReferenceDto, ConfigureZoomCredentialDto, InitiateCommunicationCallDto, RecordDispositionDto, UpsertProviderIdentityDto } from './dto/communications.dto.js';
import type {
  CommunicationCapabilitiesDto,
  CommunicationConnectionTestResultDto,
  CommunicationInteractionViewDto,
  CommunicationProviderConfigListDto,
  CommunicationProviderIdentityDto,
  CommunicationProviderIdentityListDto,
  VoiceEngagementEvidenceDto,
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
    private readonly timeline: CommunicationTimelineService,
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
    @Req() req: Request,
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
    // COMM-C2A — the caller's visible requisition set (global VisibilityInterceptor)
    // is threaded into the call orchestration so the CONTACT side effect honours
    // the same concealment as the Pipeline surface.
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.calls.initiate(auth, dto, requestId, visibleReqIds);
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

  // COMM-C1 — tenant communication provider CONFIGURATION admin (Settings →
  // Integrations → Communications). Authorized by integration:* (configuring the
  // tenant's provider integration), NOT communication:* — mirrors the
  // provider-identity admin routes above. Provider-neutral list contract; the
  // credential/test actions are Zoom-specific by nature (typed Zoom bundle).

  // Tolerant admin read: returns every administered provider with its config
  // state, including `not_configured` — never 409s on an un-provisioned tenant.
  @Get('providers')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async listProviders(
    @AuthContext() auth: AuthContextType,
  ): Promise<CommunicationProviderConfigListDto> {
    const items = await this.comms.listProviderConfigurations(auth.tenant_id);
    return { items };
  }

  // Write-only credential configure/update. The typed Zoom bundle is validated +
  // encoded server-side and written through the Integration credential path to
  // Secrets Manager; NO secret/token is persisted to Postgres or returned.
  @Post('providers/zoom/credential')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async configureZoomCredential(
    @Body() dto: ConfigureZoomCredentialDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationProviderConfigListDto> {
    const bundle: ZoomCredentialBundle = {
      access_token: dto.access_token,
      ...(dto.refresh_token !== undefined ? { refresh_token: dto.refresh_token } : {}),
      ...(dto.token_type !== undefined ? { token_type: dto.token_type } : {}),
      ...(dto.scope !== undefined ? { scope: dto.scope } : {}),
      ...(dto.expires_at !== undefined ? { expires_at: dto.expires_at } : {}),
      ...(dto.account_id !== undefined ? { account_id: dto.account_id } : {}),
    };
    const item = await this.comms.configureZoomCredential(auth.tenant_id, bundle, requestId);
    return { items: [item] };
  }

  // Tenant-admin connection test — structural validateConnection only (no live
  // external ping; B8-deferred). Never mutates recruiting state; never echoes a
  // secret. No usable connection -> 409 COMMUNICATION_PROVIDER_NOT_CONFIGURED.
  @Post('providers/zoom/test')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async testZoomConnection(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommunicationConnectionTestResultDto> {
    return this.comms.testProviderConnection(auth.tenant_id, requestId);
  }

  // COMM-C2A — provider-neutral derived voice-engagement evidence for a
  // Talent × Requisition (attempt vs recruiter/provider two-way conversation).
  // A read projection over existing Communications rows (no new table). Gated
  // communication:read; tenant-scoped. Lane 2 consumes these neutral facts.
  @Get('voice-evidence')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async voiceEvidence(
    @Query('talent_id') talentId: string,
    @Query('requisition_id') requisitionId: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<VoiceEngagementEvidenceDto> {
    if (!UUID_REGEX.test(talentId ?? '') || !UUID_REGEX.test(requisitionId ?? '')) {
      throw new AramoError('VALIDATION_ERROR', 'talent_id and requisition_id must be UUIDs', 400, {
        requestId,
        details: { talent_id: talentId ?? null, requisition_id: requisitionId ?? null },
      });
    }
    return this.comms.getVoiceEvidence(auth.tenant_id, talentId, requisitionId);
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

  // COMM-B7 — record a disposition (append-only history) on an interaction.
  // Gated communication:disposition:write; when notes is non-blank the service
  // ALSO requires communication:notes:write. State-agnostic; tenant-safe 404.
  @Post('interactions/:interactionId/disposition')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('communication:disposition:write')
  async recordDisposition(
    @Param('interactionId', ParseUUIDPipe) interactionId: string,
    @Body() dto: RecordDispositionDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ id: string }> {
    return this.timeline.recordDisposition(auth, interactionId, dto, requestId);
  }

  // COMM-B8 — attach the provider correlation id captured post-dial (embed→
  // provider-id), closing the dial-time gap so a real webhook can correlate.
  // communication:voice:call (the same recruiter action as the call); tenant+
  // owner-safe 404; convergent-or-conflict 409; no external side effect.
  @Post('interactions/:interactionId/provider-reference')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:voice:call')
  async attachProviderReference(
    @Param('interactionId', ParseUUIDPipe) interactionId: string,
    @Body() dto: AttachProviderReferenceDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ id: string }> {
    return this.timeline.attachProviderReference(auth, interactionId, dto, requestId);
  }
}
