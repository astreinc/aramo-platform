import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { CommercialAuditCursorError, CommercialAuditRepository, type CommercialAuditEventRow } from '@aramo/subscription';

import type { CommercialAuditEventDto, CommercialAuditListResponseDto } from './dto/commercial-audit.dto.js';
import { CommercialAuditQueryDto } from './dto/commercial-audit.dto.js';

// CCP-A2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A2) — the READ-ONLY
// commercial audit explorer feed over subscription."CommercialAuditEvent" (append-only at
// the DB). platform:commercial:audit:read, held by platform_owner, finance_admin and
// read_only_auditor only (CCP A1 §4.1); super_admin holds no commercial scope (INV-1,
// PBD §12) and is refused. Platform consumer only (the DDR §13.1 tripwire).
//
// Filters (ANDed): actor_id, event_type, tenant_id, from (inclusive), to (exclusive),
// exception_only. Newest first; opaque keyset cursor pinned to the filter set.

@Controller('platform/commercial')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialAuditController {
  constructor(private readonly audit: CommercialAuditRepository) {}

  @Get('audit-events')
  @RequireScopes('platform:commercial:audit:read')
  async list(
    @Query() query: CommercialAuditQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialAuditListResponseDto> {
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
    const from = query.from === undefined ? undefined : new Date(query.from);
    const to = query.to === undefined ? undefined : new Date(query.to);
    if (from !== undefined && to !== undefined && from.getTime() >= to.getTime()) {
      throw new AramoError('VALIDATION_ERROR', '`from` must be earlier than `to`', 400, {
        requestId,
        details: { reason: 'invalid_date_range' },
      });
    }
    try {
      const page = await this.audit.list({
        actor_id: query.actor_id,
        event_type: query.event_type,
        tenant_id: query.tenant_id,
        from,
        to,
        exception_only: query.exception_only === 'true',
        limit: query.limit,
        cursor: query.cursor,
      });
      return { events: page.events.map(toDto), next_cursor: page.next_cursor };
    } catch (err) {
      if (err instanceof CommercialAuditCursorError) {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'invalid_cursor' } });
      }
      throw err;
    }
  }
}

function toDto(row: CommercialAuditEventRow): CommercialAuditEventDto {
  return {
    id: row.id,
    created_at: row.created_at.toISOString(),
    actor_id: row.actor_id,
    actor_type: row.actor_type,
    actor_role_keys: row.actor_role_keys,
    event_type: row.event_type,
    is_exception: row.is_exception,
    tenant_id: row.tenant_id,
    subject: row.subject,
    change_request_id: row.change_request_id,
    policy_version_id: row.policy_version_id,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    correlation_id: row.correlation_id,
  };
}
