import { Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, PLATFORM_TENANT_SENTINEL_ID, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  CommercialApplyFailedError,
  CommercialApplyRefusedError,
  CommercialApplyService,
  CommercialChangeRequestError,
  explanationOf,
  type CommercialCatalogApplicationRow,
  type CommercialChangeApplicationRow,
} from '@aramo/subscription';

import type { CommercialCatalogApplicationDto, CommercialChangeApplicationDto } from './dto/commercial-change-application.dto.js';
import type { CommercialChangeRequestDto } from './dto/commercial-change-request.dto.js';
import { requestDto, toAramoError } from './platform-commercial-change-request.controller.js';
import { amountAccess } from './finance-amount-access.js';

// CCP-A6 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A6; Conversion Rule C-21…C-24)
// — POST /platform/commercial/change-requests/{id}/apply: applies an APPROVED (or APPLY_FAILED,
// retry) request of an A6 action type (SUBSCRIPTION_OPEN / _CHANGE / _END, ENTITLEMENT_GRANT) or
// the CCP-A7 governed revoke (ENTITLEMENT_REVOKE) in ONE local transaction under the shared
// billing lock (CommercialApplyService).
//
// Route gate `platform:approval:read` (the 6 CCP roles, never super_admin; as every CCP-A3
// route). Below the gate the service is the authority: the action's REQUESTER scope (TD-A6-3),
// then the NC-5 re-check of every approval under the request's snapshotted chain.
//   200  applied, or replayed (an APPLIED request: idempotent, nothing written)
//   403  requester_scope_missing | not_human | not_requester | requester_no_longer_authorized
//        (CCP-A6-R, TD-A6-3: only the ORIGINAL requester, with live authority)
// CCP-B2-backend — PLAN_VERSION_PUBLISH / PLAN_RETIRE use the same route (catalog_application).
// Every refusal and failure carries a stable code and an operator-facing `explanation`.
//   409  COMMERCIAL_CHANGE_REQUEST_CONFLICT  reason apply_refused (NC-5 / not approved; no state
//        change), apply_failed (rolled back, request now APPLY_FAILED, retryable),
//        action_not_applicable, integrity
// A separate controller (same base path) so the CCP-A3 controller and its specs are unchanged.

@Controller('platform/commercial/change-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialApplyController {
  constructor(private readonly apply: CommercialApplyService) {}

  @Post(':id/apply')
  @HttpCode(200)
  @RequireScopes('platform:approval:read')
  async applyRequest(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto; application: CommercialChangeApplicationDto | null; catalog_application: CommercialCatalogApplicationDto | null; replayed: boolean }> {
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
    try {
      const out = await this.apply.apply(
        { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes },
        id,
        { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId },
      );
      return {
        request: requestDto(out.request, amountAccess(auth)),
        application: out.application === null ? null : applicationDto(out.application),
        catalog_application: out.catalog_application === null ? null : catalogApplicationDto(out.catalog_application),
        replayed: out.replayed,
      };
    } catch (err) {
      throw applyHttpError(err, requestId);
    }
  }
}

export function applyHttpError(err: unknown, requestId: string): unknown {
  if (err instanceof CommercialApplyRefusedError) {
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', `apply refused: ${err.reason}`, 409, {
      requestId,
      details: { reason: 'apply_refused', refusal: err.reason, explanation: explanationOf(err.reason), ...err.detail },
    });
  }
  if (err instanceof CommercialApplyFailedError) {
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, {
      requestId,
      details: { reason: 'apply_failed', failure: err.code, explanation: err.explanation, attempt: err.attempt, request_state: err.request_state, ...err.detail },
    });
  }
  if (err instanceof CommercialChangeRequestError && err.code === 'ACTION_NOT_APPLICABLE') {
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'action_not_applicable', explanation: explanationOf(err.code), ...err.details } });
  }
  if (err instanceof CommercialChangeRequestError && err.code === 'REQUESTER_NO_LONGER_AUTHORIZED') {
    return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'requester_no_longer_authorized', explanation: explanationOf(err.code), ...err.details } });
  }
  if (err instanceof CommercialChangeRequestError && err.code === 'APPLY_EXPIRED') {
    // Charter Amendment A1 (AD-7) — the apply deadline passed; the request is APPLY_EXPIRED.
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'apply_expired', explanation: explanationOf(err.code), ...err.details } });
  }
  if (err instanceof CommercialChangeRequestError && err.code === 'NOT_REQUESTER') {
    return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'not_requester', explanation: explanationOf(err.code) } });
  }
  return toAramoError(err, requestId);
}

export function applicationDto(a: CommercialChangeApplicationRow): CommercialChangeApplicationDto {
  return {
    id: a.id,
    change_request_id: a.change_request_id,
    action_type: a.action_type,
    tenant_id: a.tenant_id,
    product_key: a.product_key,
    subscription_id: a.subscription_id,
    replaced_subscription_id: a.replaced_subscription_id,
    from_plan_version_id: a.from_plan_version_id,
    to_plan_version_id: a.to_plan_version_id,
    capabilities: a.capabilities,
    capabilities_inserted: a.capabilities_inserted,
    capabilities_revoked: a.capabilities_revoked,
    attempt: a.attempt,
    applied_by: a.applied_by,
    applied_at: a.applied_at.toISOString(),
  };
}

export function catalogApplicationDto(a: CommercialCatalogApplicationRow): CommercialCatalogApplicationDto {
  return {
    id: a.id,
    change_request_id: a.change_request_id,
    action_type: a.action_type,
    plan_id: a.plan_id,
    plan_version_id: a.plan_version_id,
    retired_plan_version_id: a.retired_plan_version_id,
    provider_price_ref: a.provider_price_ref,
    attempt: a.attempt,
    applied_by: a.applied_by,
    applied_at: a.applied_at.toISOString(),
  };
}
