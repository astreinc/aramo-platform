import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
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
  ScheduleInterviewRequestDto,
  TransitionInterviewSessionRequestDto,
} from './dto/interview-session-request.dto.js';
import { ClientSelectionProcessRepository } from './client-selection.repository.js';
import { InterviewSessionRepository } from './interview-session.repository.js';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    const view = await this.interviews.scheduleInterview({
      tenant_id: authContext.tenant_id,
      client_selection_process_id: id,
      interview_type: body.interview_type,
      ...(body.round === undefined ? {} : { round: body.round }),
      scheduled_at: new Date(body.scheduled_at),
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
    const visibleReqIds = await req.resolveVisibleRequisitionIds!();
    return this.interviews.transitionInterview({
      tenant_id: authContext.tenant_id,
      id: sessionId,
      to_state: body.to_state,
      expected_version: body.expected_version,
      ...(body.scheduled_at === undefined
        ? {}
        : { scheduled_at: new Date(body.scheduled_at) }),
      changed_by_id: authContext.sub,
      requestId,
      visible_requisition_ids: visibleReqIds,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
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
