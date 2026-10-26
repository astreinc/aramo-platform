import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, PLATFORM_TENANT_SENTINEL_ID, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  CommercialChangeRequestError,
  CommercialConversionService,
  ConversionApplyFailedError,
  type ConversionView,
} from '@aramo/subscription';

import type { CommercialChangeRequestDto } from './dto/commercial-change-request.dto.js';
import type { ConversionDto } from './dto/commercial-conversion.dto.js';
import { applicationDto, applyHttpError } from './platform-commercial-apply.controller.js';
import { billingCommandDto } from './platform-commercial-billing.controller.js';
import { requestDto } from './platform-commercial-change-request.controller.js';
import { amountAccess, financeReader } from './finance-amount-access.js';

// CCP-C2 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C2; Conversion Rule C-11…C-15, C-23)
// — the governed manual ↔ self-service conversion of an APPROVED CONVERSION change request.
//   POST /platform/commercial/change-requests/{id}/convert   apply it (CommercialConversionService)
//   GET  /platform/commercial/change-requests/{id}/conversion read its state (direction, status,
//        pending_provider, the release, the provider commands, the application)
//
// Route gate `platform:approval:read` (the 6 CCP roles, never super_admin; as every CCP request
// route). Below the gate the service is the authority: REQUESTER-ONLY apply (TD-A6-3 narrowed by
// TD-B2-3): the requester scope AND the actor = requested_by; then NC-5 and the snapshotted apply
// deadline.
//   200  applied / released, pending-provider (self-service → governed), or replayed
//   403  requester_scope_missing | not_requester | not_human
//   409  COMMERCIAL_CHANGE_REQUEST_CONFLICT  reason apply_refused (no state change), apply_failed
//        (rolled back, APPLY_FAILED, retryable), action_not_applicable (not a CONVERSION), apply_expired
//        (Charter Amendment A1; CCP-FIX1 O-D4-2: the same body as POST …/apply, via applyHttpError)
// No console mutation beyond the governed apply (PLATFORM-UX-1 A1-2); the console itself is B3's.
// Nothing here reports an external (Stripe) change as committed before the provider confirmed it.

@Controller('platform/commercial/change-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialConversionController {
  constructor(private readonly conversions: CommercialConversionService) {}

  @Post(':id/convert')
  @HttpCode(200)
  @RequireScopes('platform:approval:read')
  async convert(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto; conversion: ConversionDto; replayed: boolean }> {
    assertPlatformTier(auth, requestId);
    try {
      const out = await this.conversions.apply(
        { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes },
        id,
        { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId },
      );
      return { request: requestDto(out.request, financeReader(auth)), conversion: conversionDto(out, amountAccess(auth)), replayed: out.replayed };
    } catch (err) {
      throw conversionHttpError(err, requestId);
    }
  }

  @Get(':id/conversion')
  @RequireScopes('platform:approval:read')
  async read(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto; conversion: ConversionDto }> {
    assertPlatformTier(auth, requestId);
    try {
      const view = await this.conversions.view(id);
      return { request: requestDto(view.request, financeReader(auth)), conversion: conversionDto(view, amountAccess(auth)) };
    } catch (err) {
      throw conversionHttpError(err, requestId);
    }
  }
}

function assertPlatformTier(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

function conversionHttpError(err: unknown, requestId: string): unknown {
  if (err instanceof ConversionApplyFailedError) {
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, {
      requestId,
      details: { reason: 'apply_failed', failure: err.code, attempt: err.attempt, request_state: err.request_state, ...err.detail },
    });
  }
  if (err instanceof CommercialChangeRequestError && err.code === 'ACTION_NOT_APPLICABLE') {
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'action_not_applicable', ...err.details } });
  }
  return applyHttpError(err, requestId);
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function conversionDto(v: ConversionView, amount_access: boolean): ConversionDto {
  const r = v.release;
  return {
    direction: v.direction,
    status: v.status,
    pending_provider: v.pending_provider,
    release:
      r === null
        ? null
        : {
            id: r.id,
            change_request_id: r.change_request_id,
            tenant_id: r.tenant_id,
            product_key: r.product_key,
            governed_subscription_id: r.governed_subscription_id,
            plan_id: r.plan_id,
            plan_version_id: r.plan_version_id,
            held_subscription_ref: r.held_subscription_ref,
            state: r.state,
            effective_state: r.effective_state,
            expires_at: r.expires_at.toISOString(),
            intent_id: r.intent_id,
            consumed_at: iso(r.consumed_at),
            self_service_subscription_id: r.self_service_subscription_id,
            converted_at: iso(r.converted_at),
            expired_at: iso(r.expired_at),
            created_by: r.created_by,
            created_at: r.created_at.toISOString(),
          },
    commands: v.commands.map((c) => billingCommandDto(c, amount_access)),
    application: v.application === null ? null : applicationDto(v.application),
  };
}
