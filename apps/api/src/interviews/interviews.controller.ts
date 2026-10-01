import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { isInterviewSessionState } from '@aramo/client-selection';

import type { InterviewCalendarView } from './dto/interview-calendar.view.js';
import { InterviewsService } from './interviews.service.js';

// The maximum calendar window span — a bounded read (Calendar/Interview §6): a caller
// cannot request an unbounded range. 62 days covers a two-month calendar view.
const MAX_WINDOW_MS = 62 * 24 * 60 * 60 * 1000;

// GET /v1/interviews — the recruiter interview CALENDAR read (Calendar/Interview §6).
// One visibility-scoped, date-bounded payload sourced from InterviewSession (the
// interview authority; NEVER CalendarEvent). READ ONLY. Guard chain + scope mirror the
// ATS norm and reuse `client-selection:read` (§25 — no new scope, no seed churn). Tenant
// + visibility are resolved server-side; no client-supplied tenant/user/requisition id is
// ever trusted (§29). A caller-supplied requisition_id outside the visible set is
// concealed by the underlying read (empty), never widened.
@Controller('v1/interviews')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class InterviewsController {
  constructor(private readonly service: InterviewsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('client-selection:read')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('requisition_id') requisitionId: string | undefined,
    @Query('talent_id') talentId: string | undefined,
    @Query('interviewer_user_id') interviewerUserId: string | undefined,
    @Query('state') state: string | undefined,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @RequestId() requestId: string,
    @Req() req: Request,
  ): Promise<InterviewCalendarView> {
    const fromDate = this.parseInstant(from, 'from', requestId);
    const toDate = this.parseInstant(to, 'to', requestId);
    if (toDate.getTime() <= fromDate.getTime()) {
      throw new AramoError('VALIDATION_ERROR', 'to must be after from', 422, {
        requestId,
        details: { field: 'to' },
      });
    }
    if (toDate.getTime() - fromDate.getTime() > MAX_WINDOW_MS) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'Calendar window is too large (max 62 days)',
        422,
        { requestId, details: { field: 'to' } },
      );
    }
    if (state !== undefined && !isInterviewSessionState(state)) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'state is not a valid interview-session state',
        422,
        { requestId, details: { field: 'state' } },
      );
    }
    const [visibility, visible_requisition_ids] = await Promise.all([
      req.resolveVisibility!(),
      req.resolveVisibleRequisitionIds!(),
    ]);
    return this.service.listCalendar(
      {
        tenant_id: authContext.tenant_id,
        user_id: authContext.sub,
        ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
        visibility,
        visible_requisition_ids,
      },
      {
        from: fromDate,
        to: toDate,
        ...(requisitionId === undefined ? {} : { requisition_id: requisitionId }),
        ...(talentId === undefined ? {} : { talent_record_id: talentId }),
        ...(interviewerUserId === undefined
          ? {}
          : { interviewer_user_id: interviewerUserId }),
        ...(state === undefined ? {} : { state }),
      },
    );
  }

  private parseInstant(
    v: string | undefined,
    field: string,
    requestId: string,
  ): Date {
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) {
      throw new AramoError(
        'VALIDATION_ERROR',
        `${field} (ISO timestamp) is required`,
        422,
        { requestId, details: { field } },
      );
    }
    return new Date(v);
  }
}
