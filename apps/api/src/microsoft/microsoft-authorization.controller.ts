import { Body, Controller, Get, HttpCode, HttpStatus, Logger, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError, RequestId } from '@aramo/common';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import {
  type MicrosoftScopeCapability,
} from '@aramo/microsoft-graph';

import {
  CancelMicrosoftCalendarMeetingRequestDto,
  ConfigureMicrosoftConnectionRequestDto,
  CreateMicrosoftCalendarMeetingRequestDto,
  CreateMicrosoftMeetingRequestDto,
  RescheduleMicrosoftCalendarMeetingRequestDto,
  SendMicrosoftEmailRequestDto,
} from './dto/microsoft.dto.js';
import {
  MeetingNotFoundError,
  MicrosoftSchedulingService,
  type ScheduledMeetingView,
} from './microsoft-scheduling.service.js';
import {
  MicrosoftAuthorizationOrchestrator,
  type MicrosoftProviderStatusView,
  type RecruiterBindingStatusView,
} from './microsoft-authorization.orchestrator.js';
import type { EmailSendResultView } from './microsoft-email.service.js';
import { MicrosoftEmailService } from './microsoft-email.service.js';
import type { MeetingResultView } from './microsoft-meeting.service.js';
import { MicrosoftMeetingService } from './microsoft-meeting.service.js';
import { mapMicrosoftError } from './microsoft-error-mapper.js';

// A1 R4 — closed-enum resolver for the opt-in scheduling capability on authorize/start.
// Omitted/empty/'baseline' → undefined (the established baseline permission set, unchanged).
// 'scheduling' → the opt-in set that adds Calendars.ReadWrite. Any other value FAILS CLOSED
// with a validation error — never silently coerced to baseline or elevated.
export function resolveAuthorizeCapability(
  raw: string | undefined,
  requestId: string,
): MicrosoftScopeCapability | undefined {
  if (raw === undefined || raw === '' || raw === 'baseline') return undefined;
  if (raw === 'scheduling') return 'scheduling';
  // TIP-E2E INC-3 A1 Part E — screening meeting artifacts (post-meeting
  // transcripts): the scheduling set plus the two delegated artifact read scopes.
  if (raw === 'meeting_artifacts') return 'meeting_artifacts';
  throw new AramoError('VALIDATION_ERROR', `unsupported authorize capability '${raw}'`, 400, {
    requestId,
    details: { field: 'capability' },
  });
}

// COMM-C2B — recruiter + tenant-admin Microsoft surface (R2/R5/R7/R11/R15). Three-
// axis authorization (JwtAuthGuard + EntitlementGuard + RolesGuard); the recruiter
// identity comes from the JWT (never the body). Service refusals map to typed,
// token-free error codes so the recruiter UX can distinguish reauthorization from
// consent denial from unconfigured-provider.
@Controller('v1/integrations/microsoft')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class MicrosoftAuthorizationController {
  private readonly logger = new Logger(MicrosoftAuthorizationController.name);

  constructor(
    private readonly orchestrator: MicrosoftAuthorizationOrchestrator,
    private readonly email: MicrosoftEmailService,
    private readonly meeting: MicrosoftMeetingService,
    private readonly scheduling: MicrosoftSchedulingService,
  ) {}

  /** Begin delegated authorization — returns the Microsoft authorize URL. */
  @Get('authorize/start')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:read')
  async start(
    @AuthContext() auth: AuthContextType,
    @Query('connection_id') connectionId: string | undefined,
    @Query('capability') capability: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ authorize_url: string }> {
    // A1 R4 — opt-in scheduling consent. Closed enum, FAIL-CLOSED: omitted keeps the
    // baseline permission set; only an explicit 'scheduling' widens to Calendars.ReadWrite;
    // any other value is rejected (never silently treated as baseline or elevated).
    const resolvedCapability = resolveAuthorizeCapability(capability, requestId);
    try {
      const { authorizeUrl } = await this.orchestrator.start(auth.tenant_id, auth.sub, connectionId, resolvedCapability);
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

  /**
   * Tenant-admin provider status — configuration_state + recruiter mapping counts.
   * NEVER throws when unconfigured (PART B/B5): a safe-disconnected tenant reads as
   * NOT_CONFIGURED with zero recruiter bindings, so the admin UI can render a
   * first-class "Configure" affordance instead of an error.
   */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:read')
  async status(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<MicrosoftProviderStatusView> {
    try {
      return await this.orchestrator.getProviderStatus(auth.tenant_id);
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /**
   * PART B — tenant-admin establishment: create/update the Microsoft connection.
   * Non-secret config (client_id + authority_tenant) is stored on the governed
   * IntegrationConnection; the client secret (when supplied) is written WRITE-ONLY
   * to Secrets Manager and NEVER returned. Authorized by integration:write.
   */
  @Post('configure')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('integration:write')
  async configure(
    @AuthContext() auth: AuthContextType,
    @Body() dto: ConfigureMicrosoftConnectionRequestDto,
    @RequestId() requestId: string,
  ): Promise<MicrosoftProviderStatusView> {
    try {
      return await this.orchestrator.configureConnection(auth.tenant_id, {
        client_id: dto.client_id,
        authority_tenant: dto.authority_tenant,
        ...(dto.client_secret === undefined ? {} : { client_secret: dto.client_secret }),
      });
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
    @Req() req: Request,
  ): Promise<EmailSendResultView> {
    // COMM-C4 — the caller's visible requisition set (global VisibilityInterceptor)
    // threaded into the send so the acceptance→CONTACT orchestration honours the
    // same concealment as the Pipeline surface.
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    try {
      return await this.email.sendRecruiterEmail({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        connection_id: body.connection_id,
        talent_record_id: body.talent_record_id,
        requisition_id: body.requisition_id,
        pipeline_id: body.pipeline_id,
        subject: body.subject,
        body: body.body,
        idempotency_key: body.idempotency_key,
        // ET-8 — descriptive provenance of the reviewed draft (server records as-is).
        template_key: body.template_key,
        template_id: body.template_id,
        authContext: auth,
        requestId,
        visible_requisition_ids: visibleReqIds,
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

  // ── COMM-C2B Amendment A1 (M365-SCHED-1) — Outlook calendar scheduling ──────
  // SEPARATE from create-link-only /meeting. The recruiter organizer comes from the
  // JWT (never the body); mutation routes are organizer-bound at the service layer.

  /** Schedule an Outlook calendar meeting (attendee invitation + Teams). */
  @Post('calendar-meeting')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:meeting:create')
  async scheduleCalendarMeeting(
    @AuthContext() auth: AuthContextType,
    @Body() body: CreateMicrosoftCalendarMeetingRequestDto,
    @RequestId() requestId: string,
  ): Promise<ScheduledMeetingView> {
    try {
      return await this.scheduling.scheduleMeeting({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        connection_id: body.connection_id,
        talent_record_id: body.talent_record_id,
        requisition_id: body.requisition_id,
        pipeline_id: body.pipeline_id,
        subject: body.subject,
        start_date_time: body.start_date_time,
        end_date_time: body.end_date_time,
        time_zone: body.time_zone,
        idempotency_key: body.idempotency_key,
        authContext: auth,
        requestId,
      });
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** Read a scheduling meeting (last-known synchronized state, never guaranteed-live). */
  @Get('calendar-meeting/:id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:meeting:read')
  async readCalendarMeeting(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<ScheduledMeetingView> {
    try {
      const view = await this.scheduling.readMeeting(auth.tenant_id, id);
      if (view === null) {
        throw new MeetingNotFoundError();
      }
      return view;
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** List upcoming scheduling meetings by Talent/Requisition context. */
  @Get('calendar-meetings')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:meeting:read')
  async listCalendarMeetings(
    @AuthContext() auth: AuthContextType,
    @Query('talent_record_id') talentRecordId: string | undefined,
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @RequestId() requestId: string,
  ): Promise<{ meetings: ScheduledMeetingView[] }> {
    try {
      const now = new Date();
      const fromDate = from !== undefined ? new Date(from) : now;
      const toDate = to !== undefined ? new Date(to) : new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const meetings = await this.scheduling.listUpcoming({
        tenant_id: auth.tenant_id,
        talent_record_id: talentRecordId,
        requisition_id: requisitionId,
        from: fromDate,
        to: toDate,
      });
      return { meetings };
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** Reschedule a scheduling meeting — updates the SAME Outlook event (organizer-bound, CAS). */
  @Patch('calendar-meeting/:id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:meeting:edit')
  async rescheduleCalendarMeeting(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: RescheduleMicrosoftCalendarMeetingRequestDto,
    @RequestId() requestId: string,
  ): Promise<ScheduledMeetingView> {
    try {
      return await this.scheduling.rescheduleMeeting({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        connection_id: body.connection_id,
        interaction_id: id,
        expected_version: body.expected_version,
        start_date_time: body.start_date_time,
        end_date_time: body.end_date_time,
        time_zone: body.time_zone,
        requestId,
      });
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  /** Cancel a scheduling meeting — targets the SAME Outlook event (organizer-bound, idempotent). */
  @Post('calendar-meeting/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('communication:meeting:cancel')
  async cancelCalendarMeeting(
    @AuthContext() auth: AuthContextType,
    @Param('id') id: string,
    @Body() body: CancelMicrosoftCalendarMeetingRequestDto,
    @RequestId() requestId: string,
  ): Promise<ScheduledMeetingView> {
    try {
      return await this.scheduling.cancelMeeting({
        tenant_id: auth.tenant_id,
        recruiter_id: auth.sub,
        connection_id: body.connection_id,
        interaction_id: id,
        expected_version: body.expected_version,
        comment: body.comment,
        requestId,
      });
    } catch (err) {
      throw this.mapError(err, requestId);
    }
  }

  private mapError(err: unknown, requestId: string): AramoError {
    return mapMicrosoftError(err, requestId, this.logger);
  }
}
