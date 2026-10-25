import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  BillingCommandError,
  BillingCommandService,
  BillingWebhookInboxQueryError,
  BillingWebhookInboxService,
  isAdjustmentCommandKind,
  withholdAmounts,
  type BillingCommandRow,
  type BillingWebhookInboxRow,
} from '@aramo/subscription';

import {
  BillingCommandQueryDto,
  BillingWebhookInboxQueryDto,
  type BillingCommandDto,
  type BillingCommandListResponseDto,
  type BillingWebhookInboxEventDto,
  type BillingWebhookInboxListResponseDto,
} from './dto/commercial-billing.dto.js';

// CCP-C1 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C1 "operator-visible failure
// states"; Conversion Rule C-22, C-23) — READ-ONLY operator views of the Stripe command outbox and
// the webhook inbox. platform:billing:read (CCP A1 §4.1: platform_owner, finance_admin,
// commercial_ops, support_admin, read_only_auditor; never catalog_manager, never super_admin).
// Platform consumer only. No mutation route (PLATFORM-UX-1 A1-2): a failed command is retried by
// the service (BillingCommandService.retryFailed) under the recovery runbook, never from the console.
//
//   GET billing-commands        state / tenant_id / change_request_id filters; newest first
//   GET billing-webhook-inbox   status filter; newest first
// Both page with an opaque keyset cursor pinned to the filter set (400 invalid_cursor otherwise).

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function billingCommandDto(row: BillingCommandRow): BillingCommandDto {
  return {
    id: row.id,
    provider: row.provider,
    command_kind: row.command_kind,
    change_request_id: row.change_request_id,
    step: row.step,
    idempotency_key: row.idempotency_key,
    tenant_id: row.tenant_id,
    product_key: row.product_key,
    target_ref: row.target_ref,
    // CCP-C4 (Finance amount interim) — a billing-adjustment command's amount is withheld.
    params: isAdjustmentCommandKind(row.command_kind) ? withholdAmounts((row.params ?? {}) as Record<string, unknown>) : ((row.params ?? {}) as Record<string, unknown>),
    state: row.state,
    pending_provider: row.state !== 'CONFIRMED',
    attempts: row.attempts,
    next_attempt_at: iso(row.next_attempt_at),
    failure: row.last_error_code === null ? null : { code: row.last_error_code, detail: row.last_error_detail },
    last_detail: row.last_error_detail,
    provider_accepted_at: iso(row.provider_accepted_at),
    confirmed_at: iso(row.confirmed_at),
    confirmation_source: row.confirmation_source,
    confirmation_event_id: row.confirmation_event_id,
    failed_at: iso(row.failed_at),
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function billingWebhookInboxDto(row: BillingWebhookInboxRow): BillingWebhookInboxEventDto {
  return {
    id: row.id,
    provider: row.provider,
    provider_event_id: row.provider_event_id,
    event_type: row.event_type,
    event_created_at: row.event_created_at.toISOString(),
    subscription_ref: row.subscription_ref,
    checkout_session_ref: row.checkout_session_ref,
    product_key: row.product_key,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: iso(row.next_attempt_at),
    outcome: row.outcome,
    detail: row.detail,
    last_error: row.last_error,
    received_at: row.received_at.toISOString(),
    processed_at: iso(row.processed_at),
  };
}

@Controller('platform/commercial')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialBillingController {
  constructor(
    private readonly commands: BillingCommandService,
    private readonly inbox: BillingWebhookInboxService,
  ) {}

  @Get('billing-commands')
  @RequireScopes('platform:billing:read')
  async listCommands(@Query() query: BillingCommandQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<BillingCommandListResponseDto> {
    assertPlatform(auth, requestId);
    try {
      const page = await this.commands.list({ state: query.state, tenant_id: query.tenant_id, change_request_id: query.change_request_id, limit: query.limit, cursor: query.cursor });
      return { commands: page.commands.map(billingCommandDto), next_cursor: page.next_cursor };
    } catch (err) {
      if (err instanceof BillingCommandError && err.code === 'INVALID_CURSOR') {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'invalid_cursor' } });
      }
      throw err;
    }
  }

  @Get('billing-webhook-inbox')
  @RequireScopes('platform:billing:read')
  async listInbox(@Query() query: BillingWebhookInboxQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<BillingWebhookInboxListResponseDto> {
    assertPlatform(auth, requestId);
    try {
      const page = await this.inbox.list({ status: query.status, limit: query.limit, cursor: query.cursor });
      return { events: page.events.map(billingWebhookInboxDto), next_cursor: page.next_cursor };
    } catch (err) {
      if (err instanceof BillingWebhookInboxQueryError) {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'invalid_cursor' } });
      }
      throw err;
    }
  }
}
