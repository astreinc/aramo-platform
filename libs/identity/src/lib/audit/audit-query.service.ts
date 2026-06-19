import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { PrismaService } from '../prisma/prisma.service.js';
import {
  CursorDecodeError,
  decodeCursor,
  encodeCursor,
} from '../util/identity-audit-cursor.js';

import {
  categoryOf,
  summarizeDetail,
  type AuditEventView,
} from './audit-event.view.js';
import {
  EVENT_TYPES,
  IdentityAuditRepository,
  type AuditEventRow,
  type EventType,
} from './identity-audit.repository.js';

// Settings Rebuild Directive 2 — the audit query service.
//
// Validates the filter/pagination inputs, runs the tenant-scoped keyset read,
// resolves actor display names (batch User lookup), redacts + summarizes each
// payload into a human-readable detail, and builds the paginated view. All
// validation failures surface as 400 VALIDATION_ERROR (never a 500 from a bad
// cursor/date/event_type).

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditQueryInput {
  readonly tenant_id: string;
  readonly viewerScopes: readonly string[];
  readonly requestId: string;
  readonly limit?: string;
  readonly cursor?: string;
  readonly actor_id?: string;
  readonly event_type?: string;
  readonly subject_id?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface AuditQueryResult {
  readonly items: AuditEventView[];
  readonly next_cursor: string | null;
}

@Injectable()
export class AuditQueryService {
  constructor(
    private readonly auditRepo: IdentityAuditRepository,
    private readonly prisma: PrismaService,
  ) {}

  async query(input: AuditQueryInput): Promise<AuditQueryResult> {
    const { requestId } = input;
    const limit = this.parseLimit(input.limit, requestId);
    const cursor = this.parseCursor(input.cursor, requestId);
    const event_type = this.parseEventType(input.event_type, requestId);
    const actor_id = this.parseUuid('actor_id', input.actor_id, requestId);
    const subject_id = this.parseUuid('subject_id', input.subject_id, requestId);
    const from = this.parseDate('from', input.from, requestId);
    const to = this.parseDate('to', input.to, requestId);

    const filters: {
      actor_id?: string;
      event_type?: EventType;
      subject_id?: string;
      from?: Date;
      to?: Date;
    } = {};
    if (actor_id !== undefined) filters.actor_id = actor_id;
    if (event_type !== undefined) filters.event_type = event_type;
    if (subject_id !== undefined) filters.subject_id = subject_id;
    if (from !== undefined) filters.from = from;
    if (to !== undefined) filters.to = to;

    const rows = await this.auditRepo.findByTenant({
      tenant_id: input.tenant_id,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(Object.keys(filters).length > 0 ? { filters } : {}),
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const displays = await this.resolveActorDisplays(pageRows);

    const items = pageRows.map((r) =>
      this.toView(r, displays, input.viewerScopes),
    );
    const last = pageRows[pageRows.length - 1];
    const next_cursor =
      hasMore && last !== undefined
        ? encodeCursor({ created_at: last.created_at, event_id: last.id })
        : null;

    return { items, next_cursor };
  }

  private toView(
    row: AuditEventRow,
    displays: Map<string, string>,
    viewerScopes: readonly string[],
  ): AuditEventView {
    const display =
      row.actor_type === 'user'
        ? (row.actor_id !== null
            ? displays.get(row.actor_id) ?? 'Unknown user'
            : 'Unknown user')
        : row.actor_type === 'service_account'
          ? 'Service account'
          : 'System';
    return {
      id: row.id,
      event_type: row.event_type,
      category: categoryOf(row.event_type),
      actor: { id: row.actor_id, type: row.actor_type, display },
      subject_id: row.subject_id,
      detail: summarizeDetail(row.event_type, row.event_payload, viewerScopes),
      created_at: row.created_at.toISOString(),
    };
  }

  private async resolveActorDisplays(
    rows: readonly AuditEventRow[],
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        rows
          .filter((r) => r.actor_type === 'user' && r.actor_id !== null)
          .map((r) => r.actor_id as string),
      ),
    ];
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, display_name: true, email: true },
    });
    return new Map(
      users.map((u) => [u.id, (u.display_name ?? '').trim() || u.email]),
    );
  }

  private parseLimit(raw: string | undefined, requestId: string): number {
    if (raw === undefined) return DEFAULT_LIMIT;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw this.badRequest(`invalid limit: ${raw}`, requestId, { limit: raw });
    }
    return Math.min(n, MAX_LIMIT);
  }

  private parseCursor(
    raw: string | undefined,
    requestId: string,
  ): { created_at: Date; event_id: string } | undefined {
    if (raw === undefined || raw.length === 0) return undefined;
    try {
      const p = decodeCursor(raw);
      return { created_at: p.created_at, event_id: p.event_id };
    } catch (err) {
      if (err instanceof CursorDecodeError) {
        throw this.badRequest(err.message, requestId, { cursor: 'malformed' });
      }
      throw err;
    }
  }

  private parseEventType(
    raw: string | undefined,
    requestId: string,
  ): EventType | undefined {
    if (raw === undefined || raw.length === 0) return undefined;
    if (!(EVENT_TYPES as readonly string[]).includes(raw)) {
      throw this.badRequest(`unknown event_type: ${raw}`, requestId, {
        event_type: raw,
        allowed: [...EVENT_TYPES],
      });
    }
    return raw as EventType;
  }

  private parseUuid(
    field: string,
    raw: string | undefined,
    requestId: string,
  ): string | undefined {
    if (raw === undefined || raw.length === 0) return undefined;
    if (!UUID_REGEX.test(raw)) {
      throw this.badRequest(`invalid ${field}: not a UUID`, requestId, {
        [field]: raw,
      });
    }
    return raw;
  }

  private parseDate(
    field: string,
    raw: string | undefined,
    requestId: string,
  ): Date | undefined {
    if (raw === undefined || raw.length === 0) return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw this.badRequest(`invalid ${field}: not a date`, requestId, {
        [field]: raw,
      });
    }
    return d;
  }

  private badRequest(
    message: string,
    requestId: string,
    details: Record<string, unknown>,
  ): AramoError {
    return new AramoError('VALIDATION_ERROR', message, 400, {
      requestId,
      details,
    });
  }
}
