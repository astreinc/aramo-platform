import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import type { CalendarEventType } from './dto/calendar-event-type.js';
import type { CalendarEventView } from './dto/calendar-event.view.js';
import type { CreateCalendarEventRequestDto } from './dto/create-calendar-event-request.dto.js';
import type { UpdateCalendarEventRequestDto } from './dto/update-calendar-event-request.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// CalendarRepository — write + read surface for CalendarEvent.
// Reference CRUD (Ruling 7: no metering, no event log, no state machine).
//
// === THE OWNER-OR-ADMIN PREDICATE (A3 shape, single-owner field) ===
//
// The PATCH/DELETE paths apply a tenant_admin-tier override on top of
// the owner check. Both `calendar:event-edit` (recruiter) and the
// tenant_admin tier pass @RequireScopes('calendar:event-edit') at the
// RolesGuard layer; the difference is WHICH ROWS the repository
// surfaces to the editor:
//
//   - tenant_admin tier (proxy: actor scopes include
//     `calendar:event-delete` — Ruling 1 reserves :delete to
//     tenant_admin) → no owner filter; may edit any event in tenant.
//   - recruiter (`calendar:event-edit` only) → only own events
//     (owner_id == AuthContext.sub).
//
// Consequence: a recruiter PATCHing another's event surfaces 404
// NOT_FOUND (A3 info-leak-closing precedent — the scope passes; the
// row is outside the actor's visible set).
//
// `calendar:event-delete` is the tenant_admin proxy because Ruling 1
// reserves :delete to tenant_admin; no separate :edit:all scope is
// seeded (gap-avoidance per the directive — bundle is not started).

const SCOPE_DELETE_TIER = 'calendar:event-delete';

function actorSeesAll(scopes: readonly string[]): boolean {
  return scopes.includes(SCOPE_DELETE_TIER);
}

interface CalendarEventRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  owner_id: string;
  type: CalendarEventType;
  title: string;
  description: string | null;
  starts_at: Date;
  ends_at: Date | null;
  all_day: boolean;
  created_at: Date;
  updated_at: Date;
}

function projectView(row: CalendarEventRow): CalendarEventView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    owner_id: row.owner_id,
    type: row.type,
    title: row.title,
    description: row.description,
    starts_at: row.starts_at.toISOString(),
    ends_at: row.ends_at === null ? null : row.ends_at.toISOString(),
    all_day: row.all_day,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

@Injectable()
export class CalendarRepository {
  private readonly logger = new Logger(CalendarRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    tenant_id: string;
    owner_id: string;
    input: CreateCalendarEventRequestDto;
  }): Promise<CalendarEventView> {
    const { tenant_id, owner_id, input } = args;
    const row = await this.prisma.calendarEvent.create({
      data: {
        tenant_id,
        site_id: input.site_id ?? null,
        owner_id,
        type: input.type,
        title: input.title,
        description: input.description ?? null,
        starts_at: new Date(input.starts_at),
        ends_at: input.ends_at === undefined ? null : new Date(input.ends_at),
        all_day: input.all_day ?? false,
      },
    });
    return projectView(row as CalendarEventRow);
  }

  /**
   * Find a calendar event by id, tenant-scoped only (no owner filter).
   * Use for reads — every recruiter with `calendar:event-edit` (or :read
   * once seeded) may READ any tenant event; the owner predicate gates
   * only WRITE paths.
   */
  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<CalendarEventView | null> {
    const row = await this.prisma.calendarEvent.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as CalendarEventRow);
  }

  async list(args: {
    tenant_id: string;
    site_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<CalendarEventView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const startsAtFilter: { gte?: Date; lte?: Date } = {};
    if (args.from !== undefined) startsAtFilter.gte = new Date(args.from);
    if (args.to !== undefined) startsAtFilter.lte = new Date(args.to);
    const rows = await this.prisma.calendarEvent.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.site_id === undefined ? {} : { site_id: args.site_id }),
        ...(Object.keys(startsAtFilter).length === 0
          ? {}
          : { starts_at: startsAtFilter }),
      },
      orderBy: { starts_at: 'asc' },
      take: limit,
    });
    return (rows as CalendarEventRow[]).map(projectView);
  }

  /**
   * Update an event with the owner-or-admin predicate. Returns 404
   * NOT_FOUND when:
   *   - the row does not exist in tenant, OR
   *   - the row exists but the actor is not the owner AND is not in the
   *     tenant_admin tier (the A3 info-leak-closing precedent).
   */
  async update(args: {
    tenant_id: string;
    actor_user_id: string;
    actor_scopes: readonly string[];
    id: string;
    input: UpdateCalendarEventRequestDto;
    requestId: string;
  }): Promise<CalendarEventView> {
    const seesAll = actorSeesAll(args.actor_scopes);
    const existing = await this.prisma.calendarEvent.findFirst({
      where: {
        tenant_id: args.tenant_id,
        id: args.id,
        ...(seesAll ? {} : { owner_id: args.actor_user_id }),
      },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Calendar event not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    const row = await this.prisma.calendarEvent.update({
      where: { id: args.id },
      data: {
        ...(args.input.type === undefined ? {} : { type: args.input.type }),
        ...(args.input.title === undefined ? {} : { title: args.input.title }),
        ...(args.input.description === undefined
          ? {}
          : { description: args.input.description }),
        ...(args.input.starts_at === undefined
          ? {}
          : { starts_at: new Date(args.input.starts_at) }),
        ...(args.input.ends_at === undefined
          ? {}
          : { ends_at: args.input.ends_at === null ? null : new Date(args.input.ends_at) }),
        ...(args.input.all_day === undefined
          ? {}
          : { all_day: args.input.all_day }),
      },
    });
    return projectView(row as CalendarEventRow);
  }

  /**
   * Delete an event. DELETE is gated at the controller layer by the
   * `calendar:event-delete` scope (tenant_admin only per Ruling 1), so
   * the actor reaching this method is by-construction in the
   * tenant_admin tier — no owner filter is applied.
   */
  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.prisma.calendarEvent.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Calendar event not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    await this.prisma.calendarEvent.delete({ where: { id: args.id } });
  }
}
