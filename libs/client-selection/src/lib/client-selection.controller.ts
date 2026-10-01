import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, hashCanonicalizedBody, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { IdempotencyService } from '@aramo/consent';

import type { ClientSelectionProcessView } from './dto/client-selection-process.view.js';
import type { TransitionClientSelectionRequestDto } from './dto/client-selection-request.dto.js';
import type { InterviewSessionView } from './dto/interview-session.view.js';
import type {
  AssociateMeetingRequestDto,
  ScheduleInterviewRequestDto,
  TransitionInterviewSessionRequestDto,
  UpdateInterviewersRequestDto,
} from './dto/interview-session-request.dto.js';
import { ClientSelectionProcessRepository } from './client-selection.repository.js';
import { InterviewSessionRepository } from './interview-session.repository.js';
import {
  INTERVIEWER_VALIDATOR,
  type InterviewerValidatorPort,
} from './interviewer-validator.port.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Slice B — runtime IANA time-zone check (a display/input zone, never a second instant).
// `Intl.DateTimeFormat` throws RangeError on an unknown zone; a well-formed zone resolves.
function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Lane 2 / L2-F (F1 + F2) — the Client-Selection process + InterviewSession command/read
// surface. Guard chain mirrors the ATS norm: JwtAuthGuard → RolesGuard (scopes) →
// EntitlementGuard (ats capability). Reads/writes are visibility-concealed (404, never
// 403) via the requisition_id lineage (resolved by the VisibilityInterceptor). The F2
// schedule is idempotency-gated (required-UUID Idempotency-Key; the pipeline precedent).
@Controller('v1/client-selection')
@UseGuards(JwtAuthGuard, RolesGuard, EntitlementGuard)
@RequireCapability('ats')
export class ClientSelectionController {
  constructor(
    private readonly repository: ClientSelectionProcessRepository,
    private readonly interviews: InterviewSessionRepository,
    private readonly idempotencyService: IdempotencyService,
    // Slice B (§9) — cross-domain interviewer tenant-user validation, bound by apps/api.
    @Inject(INTERVIEWER_VALIDATOR)
    private readonly interviewerValidator: InterviewerValidatorPort,
  ) {}

  @Get(':id')
  @RequireScopes('client-selection:read')
  async findOne(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ClientSelectionProcessView> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.repository.findById({
      tenant_id: authContext.tenant_id,
      id,
      visible_requisition_ids: visibleReqIds,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Client-selection process not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post(':id/transition')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-selection:transition')
  async transition(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: TransitionClientSelectionRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<ClientSelectionProcessView> {
    if (typeof body.expected_version !== 'number') {
      throw new AramoError(
        'VALIDATION_ERROR',
        'expected_version is required for a client-selection transition',
        422,
        { requestId, details: { field: 'expected_version' } },
      );
    }
    // L3-E(2) refactor=replace — DECLINED/WITHDRAWN are governed decisions that also
    // disposition the upstream Pipeline episode; they are driven ONLY through
    // POST /v1/client-selection/:id/decision (ClientDecisionOrchestrator), never this
    // forward-transition route. This route drives CLIENT_REVIEW → INTERVIEW → SELECTED.
    if (body.to_state === 'DECLINED' || body.to_state === 'WITHDRAWN') {
      throw new AramoError(
        'INVALID_CLIENT_SELECTION_TRANSITION',
        'DECLINED/WITHDRAWN must be driven via POST /v1/client-selection/:id/decision (governed Pipeline disposition)',
        422,
        { requestId, details: { to_state: body.to_state, use: 'POST /v1/client-selection/:id/decision' } },
      );
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.repository.transition({
      tenant_id: authContext.tenant_id,
      id,
      to_state: body.to_state,
      expected_version: body.expected_version,
      changed_by_id: authContext.sub,
      requestId,
      visible_requisition_ids: visibleReqIds,
      ...(body.note === undefined ? {} : { note: body.note }),
      ...(body.reason_code === undefined ? {} : { reason_code: body.reason_code }),
    });
  }

  // F2 — schedule an InterviewSession under process :id. Idempotency-gated (the
  // pipeline precedent): a required-UUID Idempotency-Key makes the schedule replay-safe.
  @Post(':id/interviews')
  @RequireScopes('client-selection:interview:schedule')
  async scheduleInterview(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: ScheduleInterviewRequestDto,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<InterviewSessionView> {
    const key = this.assertIdempotencyKeyRequired(idempotencyKey, requestId);
    if (typeof body.interview_type !== 'string' || body.interview_type.length === 0) {
      throw new AramoError('VALIDATION_ERROR', 'interview_type is required', 422, {
        requestId,
        details: { field: 'interview_type' },
      });
    }
    if (typeof body.scheduled_at !== 'string' || Number.isNaN(Date.parse(body.scheduled_at))) {
      throw new AramoError('VALIDATION_ERROR', 'scheduled_at (ISO timestamp) is required', 422, {
        requestId,
        details: { field: 'scheduled_at' },
      });
    }
    this.assertEndAndTimezone(
      body.scheduled_at,
      body.scheduled_end_at,
      body.timezone,
      requestId,
    );

    const requestHash = hashCanonicalizedBody(body as unknown);
    const lookup = await this.idempotencyService.lookup({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      requestId,
    });
    if (lookup.kind === 'replay') {
      return lookup.response_body as InterviewSessionView;
    }

    // Slice B (§9) — assert every selected interviewer is a current tenant user before
    // the write (fail-closed; the store-only array is otherwise unvalidated).
    if (
      body.interviewer_user_ids !== undefined &&
      body.interviewer_user_ids.length > 0
    ) {
      await this.interviewerValidator.assertValidTenantInterviewers({
        tenant_id: authContext.tenant_id,
        interviewer_user_ids: body.interviewer_user_ids,
        requestId,
      });
    }

    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.interviews.scheduleInterview({
      tenant_id: authContext.tenant_id,
      client_selection_process_id: id,
      interview_type: body.interview_type,
      ...(body.round === undefined ? {} : { round: body.round }),
      scheduled_at: new Date(body.scheduled_at),
      ...(body.scheduled_end_at === undefined
        ? {}
        : { scheduled_end_at: new Date(body.scheduled_end_at) }),
      ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
      ...(body.interviewer_user_ids === undefined
        ? {}
        : { interviewer_user_ids: body.interviewer_user_ids }),
      created_by_id: authContext.sub,
      requestId,
      visible_requisition_ids: visibleReqIds,
    });

    await this.idempotencyService.persist({
      tenant_id: authContext.tenant_id,
      key,
      request_hash: requestHash,
      response_status: HttpStatus.CREATED,
      response_body: view as unknown as Record<string, unknown>,
    });
    return view;
  }

  @Get('interview-sessions/:sessionId')
  @RequireScopes('client-selection:read')
  async findSession(
    @AuthContext() authContext: AuthContextType,
    @Param('sessionId') sessionId: string,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<InterviewSessionView> {
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.interviews.findSessionById({
      tenant_id: authContext.tenant_id,
      id: sessionId,
      visible_requisition_ids: visibleReqIds,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Interview session not found in tenant (or not visible to actor)',
        404,
        { requestId, details: { id: sessionId } },
      );
    }
    return view;
  }

  @Post('interview-sessions/:sessionId/transition')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-selection:interview:transition')
  async transitionSession(
    @AuthContext() authContext: AuthContextType,
    @Param('sessionId') sessionId: string,
    @Body() body: TransitionInterviewSessionRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<InterviewSessionView> {
    if (typeof body.expected_version !== 'number') {
      throw new AramoError(
        'VALIDATION_ERROR',
        'expected_version is required for an interview-session transition',
        422,
        { requestId, details: { field: 'expected_version' } },
      );
    }
    // RESCHEDULED requires the new scheduled_at.
    if (
      body.to_state === 'RESCHEDULED' &&
      (typeof body.scheduled_at !== 'string' || Number.isNaN(Date.parse(body.scheduled_at)))
    ) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'scheduled_at (ISO timestamp) is required when to_state is RESCHEDULED',
        422,
        { requestId, details: { field: 'scheduled_at' } },
      );
    }
    // Slice B — end/timezone apply only to a RESCHEDULED transition (ignored otherwise).
    const rescheduling = body.to_state === 'RESCHEDULED';
    if (rescheduling) {
      this.assertEndAndTimezone(
        body.scheduled_at as string,
        body.scheduled_end_at,
        body.timezone,
        requestId,
      );
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.interviews.transitionInterview({
      tenant_id: authContext.tenant_id,
      id: sessionId,
      to_state: body.to_state,
      expected_version: body.expected_version,
      ...(body.scheduled_at === undefined
        ? {}
        : { scheduled_at: new Date(body.scheduled_at) }),
      ...(rescheduling && body.scheduled_end_at !== undefined
        ? { scheduled_end_at: new Date(body.scheduled_end_at) }
        : {}),
      ...(rescheduling && body.timezone !== undefined
        ? { timezone: body.timezone }
        : {}),
      changed_by_id: authContext.sub,
      requestId,
      visible_requisition_ids: visibleReqIds,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
  }

  // Slice C (§14) — associate a provider-neutral meeting interaction to a session. CAS on
  // expected_version. This NEVER transitions the interview (the meeting is neither
  // attendance nor completion) — a stale version → INTERVIEW_SESSION_TRANSITION_CONFLICT.
  @Post('interview-sessions/:sessionId/meeting')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-selection:interview:transition')
  async associateMeeting(
    @AuthContext() authContext: AuthContextType,
    @Param('sessionId') sessionId: string,
    @Body() body: AssociateMeetingRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<InterviewSessionView> {
    if (typeof body.expected_version !== 'number') {
      throw new AramoError('VALIDATION_ERROR', 'expected_version is required', 422, {
        requestId,
        details: { field: 'expected_version' },
      });
    }
    if (
      typeof body.meeting_interaction_id !== 'string' ||
      !UUID_REGEX.test(body.meeting_interaction_id)
    ) {
      throw new AramoError('VALIDATION_ERROR', 'meeting_interaction_id must be a UUID', 422, {
        requestId,
        details: { field: 'meeting_interaction_id' },
      });
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.interviews.associateMeeting({
      tenant_id: authContext.tenant_id,
      id: sessionId,
      expected_version: body.expected_version,
      meeting_interaction_id: body.meeting_interaction_id,
      changed_by_id: authContext.sub,
      requestId,
      visible_requisition_ids: visibleReqIds,
    });
  }

  // Slice C (§10) — replace the interviewer panel (non-terminal sessions only). CAS on
  // expected_version; each id is validated as a current tenant user before the write.
  @Patch('interview-sessions/:sessionId/interviewers')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-selection:interview:transition')
  async updateInterviewers(
    @AuthContext() authContext: AuthContextType,
    @Param('sessionId') sessionId: string,
    @Body() body: UpdateInterviewersRequestDto,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<InterviewSessionView> {
    if (typeof body.expected_version !== 'number') {
      throw new AramoError('VALIDATION_ERROR', 'expected_version is required', 422, {
        requestId,
        details: { field: 'expected_version' },
      });
    }
    if (!Array.isArray(body.interviewer_user_ids)) {
      throw new AramoError('VALIDATION_ERROR', 'interviewer_user_ids must be an array', 422, {
        requestId,
        details: { field: 'interviewer_user_ids' },
      });
    }
    if (body.interviewer_user_ids.length > 0) {
      await this.interviewerValidator.assertValidTenantInterviewers({
        tenant_id: authContext.tenant_id,
        interviewer_user_ids: body.interviewer_user_ids,
        requestId,
      });
    }
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.interviews.updateInterviewers({
      tenant_id: authContext.tenant_id,
      id: sessionId,
      expected_version: body.expected_version,
      interviewer_user_ids: body.interviewer_user_ids,
      changed_by_id: authContext.sub,
      requestId,
      visible_requisition_ids: visibleReqIds,
    });
  }

  // Slice B — validate the optional end instant + IANA zone. scheduled_end_at, when
  // supplied, MUST be after scheduled_at; timezone, when supplied, MUST be a valid IANA
  // zone. Legacy rows (no end/zone) are unaffected — nothing is fabricated.
  private assertEndAndTimezone(
    scheduledAtIso: string,
    endIso: string | undefined,
    timezone: string | undefined,
    requestId: string,
  ): void {
    if (endIso !== undefined) {
      if (typeof endIso !== 'string' || Number.isNaN(Date.parse(endIso))) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'scheduled_end_at must be an ISO timestamp',
          422,
          { requestId, details: { field: 'scheduled_end_at' } },
        );
      }
      if (Date.parse(endIso) <= Date.parse(scheduledAtIso)) {
        throw new AramoError(
          'VALIDATION_ERROR',
          'scheduled_end_at must be after scheduled_at',
          422,
          { requestId, details: { field: 'scheduled_end_at' } },
        );
      }
    }
    if (timezone !== undefined && !isValidTimeZone(timezone)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'timezone must be a valid IANA time zone',
        422,
        { requestId, details: { field: 'timezone' } },
      );
    }
  }

  private assertIdempotencyKeyRequired(
    idempotencyKey: string | undefined,
    requestId: string,
  ): string {
    if (idempotencyKey === undefined || idempotencyKey.length === 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key header is required to schedule an interview',
        400,
        { requestId, details: { header: 'Idempotency-Key' } },
      );
    }
    if (!UUID_REGEX.test(idempotencyKey)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Idempotency-Key must be a UUID',
        400,
        { requestId, details: { header: 'Idempotency-Key' } },
      );
    }
    return idempotencyKey;
  }
}
