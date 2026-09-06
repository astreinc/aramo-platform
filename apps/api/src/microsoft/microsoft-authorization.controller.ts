import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  MicrosoftIdentityNotBoundError,
  MicrosoftReauthRequiredError,
} from '@aramo/microsoft-graph';

import {
  CreateMicrosoftMeetingRequestDto,
  SendMicrosoftEmailRequestDto,
} from './dto/microsoft.dto.js';
import { EmailConsentDeniedError } from './email-consent-gate.port.js';
import {
  MicrosoftAuthorizationOrchestrator,
  type ConnectionMappingStatusView,
  type RecruiterBindingStatusView,
} from './microsoft-authorization.orchestrator.js';
import type { EmailSendResultView } from './microsoft-email.service.js';
import { MicrosoftEmailService } from './microsoft-email.service.js';
import type { MeetingResultView } from './microsoft-meeting.service.js';
import { MicrosoftMeetingService } from './microsoft-meeting.service.js';

// COMM-C2B — recruiter + tenant-admin Microsoft surface (R2/R5/R7/R11/R15). Three-
// axis authorization (JwtAuthGuard + EntitlementGuard + RolesGuard); the recruiter
// identity comes from the JWT (never the body). Service refusals map to typed,
// token-free error codes so the recruiter UX can distinguish reauthorization from
// consent denial from unconfigured-provider.
@Controller('v1/integrations/microsoft')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class MicrosoftAuthorizationController {
  constructor(
    private readonly orchestrator: MicrosoftAuthorizationOrchestrator,
    private readonly email: MicrosoftEmailService,
    private readonly meeting: MicrosoftMeetingService,
  ) {}

  /** Begin delegated authorization — returns the Microsoft authorize URL. */
  @Get('authorize/start')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async start(
    @AuthContext() auth: AuthContextType,
    @Query('connection_id') connectionId: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ authorize_url: string }> {
    try {
      const { authorizeUrl } = await this.orchestrator.start(auth.tenant_id, auth.sub, connectionId);
      return { authorize_url: authorizeUrl };
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** The signed-in recruiter's own Microsoft binding status (reauth UX). */
  @Get('me')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async me(
    @AuthContext() auth: AuthContextType,
    @Query('connection_id') connectionId: string | undefined,
    @RequestId() requestId: string,
  ): Promise<RecruiterBindingStatusView> {
    try {
      return await this.orchestrator.getRecruiterBindingStatus(auth.tenant_id, auth.sub, connectionId);
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** Tenant-admin provider status + recruiter mapping counts. */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async status(
    @AuthContext() auth: AuthContextType,
    @Query('connection_id') connectionId: string | undefined,
    @RequestId() requestId: string,
  ): Promise<ConnectionMappingStatusView> {
    try {
      return await this.orchestrator.getConnectionMappingStatus(auth.tenant_id, connectionId);
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** Send a recruiter email through the bound delegated Microsoft identity. */
  @Post('email')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:email:send')
  async sendEmail(
    @AuthContext() auth: AuthContextType,
    @Body() body: SendMicrosoftEmailRequestDto,
    @RequestId() requestId: string,
  ): Promise<EmailSendResultView> {
    try {
      return await this.email.sendRecruiterEmail({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        connection_id: body.connection_id,
        talent_record_id: body.talent_record_id,
        requisition_id: body.requisition_id,
        pipeline_id: body.pipeline_id,
        to_email: body.to_email,
        subject: body.subject,
        body: body.body,
        idempotency_key: body.idempotency_key,
        authContext: auth,
        requestId,
      });
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** Create a Teams meeting (create-link-only) through the bound delegated identity. */
  @Post('meeting')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:meeting:create')
  async createMeeting(
    @AuthContext() auth: AuthContextType,
    @Body() body: CreateMicrosoftMeetingRequestDto,
    @RequestId() requestId: string,
  ): Promise<MeetingResultView> {
    try {
      return await this.meeting.createRecruiterMeeting({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        connection_id: body.connection_id,
        talent_record_id: body.talent_record_id,
        requisition_id: body.requisition_id,
        pipeline_id: body.pipeline_id,
        subject: body.subject,
        start_date_time: body.start_date_time,
        end_date_time: body.end_date_time,
        idempotency_key: body.idempotency_key,
      });
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  private mapError(err: unknown, requestId: string): AramoError {
    if (err instanceof EmailConsentDeniedError) {
      return new AramoError('COMMUNICATION_EMAIL_CONSENT_DENIED', 'contacting consent does not permit email', 409, { requestId });
    }
    if (err instanceof MicrosoftReauthRequiredError || err instanceof MicrosoftIdentityNotBoundError) {
      return new AramoError('MICROSOFT_REAUTHORIZATION_REQUIRED', 'microsoft identity requires (re)authorization', 409, { requestId });
    }
    if (err instanceof AramoError) {
      return err;
    }
    // Unconfigured provider / no usable connection.
    return new AramoError('MICROSOFT_PROVIDER_NOT_CONFIGURED', 'no usable microsoft provider connection for tenant', 409, { requestId });
  }
}
