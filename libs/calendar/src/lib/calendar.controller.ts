import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import {
  RequireScopes,
  RequireSiteMatch,
  RolesGuard,
} from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';

import type { CalendarEventView } from './dto/calendar-event.view.js';
import type { CreateCalendarEventRequestDto } from './dto/create-calendar-event-request.dto.js';
import type { UpdateCalendarEventRequestDto } from './dto/update-calendar-event-request.dto.js';
import { CalendarRepository } from './calendar.repository.js';

// CalendarController — PR-A6 Gate 5+6 (combined) — ATS finisher.
//
// Guard chain (A2 pattern, verbatim):
//   @UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
//   @RequireCapability('ats')           // class-level — tenant axis
//   @RequireScopes(...)                 // route-level — scope axis
//   @RequireSiteMatch()                 // route-level — site axis
//
// Scope gating (proper scopes seeded in PR-A1a-2):
//   - `calendar:event-create` (recruiter+) → POST
//   - `calendar:event-edit` (recruiter+, OWN only) → PATCH; the
//     repository's owner-or-admin predicate (A3 shape) gates per-row.
//   - `calendar:event-delete` (tenant_admin only — Ruling 1) → DELETE.
//
// Read routes (GET / LIST) gate on `calendar:event-edit` at PR-A6 (no
// dedicated `calendar:event-read` scope is seeded; the catalog's tier
// granularity rolls read into the edit/create surface). Future
// HK-CAL-READ-SCOPE can split this.
@Controller('v1/calendar-events')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('ats')
export class CalendarController {
  constructor(private readonly calendarRepository: CalendarRepository) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('calendar:event-edit')
  @RequireSiteMatch()
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('site_id') siteIdFromQuery: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<{ items: CalendarEventView[] }> {
    const items = await this.calendarRepository.list({
      tenant_id: authContext.tenant_id,
      ...(siteIdFromQuery === undefined ? {} : { site_id: siteIdFromQuery }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    return { items };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('calendar:event-edit')
  @RequireSiteMatch()
  async get(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<CalendarEventView> {
    const view = await this.calendarRepository.findById({
      tenant_id: authContext.tenant_id,
      id,
    });
    if (view === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Calendar event not found in tenant',
        404,
        { requestId, details: { id } },
      );
    }
    return view;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes('calendar:event-create')
  @RequireSiteMatch()
  async create(
    @AuthContext() authContext: AuthContextType,
    @Body() body: CreateCalendarEventRequestDto,
  ): Promise<CalendarEventView> {
    return this.calendarRepository.create({
      tenant_id: authContext.tenant_id,
      owner_id: authContext.sub,
      input: body,
    });
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequireScopes('calendar:event-edit')
  @RequireSiteMatch()
  async update(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @Body() body: UpdateCalendarEventRequestDto,
    @RequestId() requestId: string,
  ): Promise<CalendarEventView> {
    return this.calendarRepository.update({
      tenant_id: authContext.tenant_id,
      actor_user_id: authContext.sub,
      actor_scopes: authContext.scopes,
      id,
      input: body,
      requestId,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireScopes('calendar:event-delete')
  @RequireSiteMatch()
  async delete(
    @AuthContext() authContext: AuthContextType,
    @Param('id') id: string,
    @RequestId() requestId: string,
  ): Promise<void> {
    await this.calendarRepository.delete({
      tenant_id: authContext.tenant_id,
      id,
      requestId,
    });
  }
}
