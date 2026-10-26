import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, PLATFORM_TENANT_SENTINEL_ID, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  BillingAdjustmentRefusedError,
  CommercialBillingAdjustmentService,
  CommercialChangeRequestError,
  explanationOf,
  type BillingAdjustmentView,
  type CommercialChangeRequestRow,
  type FinanceReader,
} from '@aramo/subscription';

import type { BillingAdjustmentDto } from './dto/commercial-billing-adjustment.dto.js';
import type { CommercialChangeRequestDto } from './dto/commercial-change-request.dto.js';
import { applyHttpError } from './platform-commercial-apply.controller.js';
import { billingCommandDto } from './platform-commercial-billing.controller.js';
import { requestDto } from './platform-commercial-change-request.controller.js';
import { amountAccess, financeReader, withholdErrorProviderText } from './finance-amount-access.js';

// CCP-C4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C4, §10; Conversion Rule C-22, C-23)
// — credits, discounts and refunds as change requests executed in Stripe by C1 durable command.
// NOT DELIVERED until the refund policy (legal) is verified; Stripe test mode only (the dispatcher
// refuses a live key, TD-C1-3).
//   POST /platform/commercial/change-requests/{id}/billing-adjustment  apply it (requester-only)
//   GET  /platform/commercial/change-requests/{id}/billing-adjustment  read its state
//   POST /platform/commercial/change-requests/{id}/billing-adjustment/resolve  CCP-C4-R: resolve an
//        unconfirmed REFUND proven not executed (requester-only; reconcile first; REFUND only)
//
// Route gate `platform:approval:read` (the 6 CCP roles, never super_admin; as every CCP request
// route). Below the gate the service is the authority: REQUESTER-ONLY apply (TD-A6-3 narrowed by
// TD-B2-3): the requester scope `platform:billing:request` AND the actor = requested_by; then the
// snapshotted apply deadline and NC-5.
//   200  pending-provider (the command is queued; APPLIED only after the provider-confirmed effect),
//        a re-armed failed command, or replayed
//   403  requester_scope_missing | not_requester | not_human
//   409  COMMERCIAL_CHANGE_REQUEST_CONFLICT  reason apply_refused (the CCP-DG refund dual gate:
//        REFUND_EXECUTION_NOT_RELEASED — gate 1, the operational switch — or REFUND_POLICY_NOT_APPROVED
//        — gate 2, the approved refund policy —; APPLY_EXPIRED, NC-5; no state change), apply_failed
//        (rolled back, APPLY_FAILED, retryable), action_not_applicable (not a billing adjustment)
// Finance amounts (CCP-R3, LOCKED Finance amount scope; merge train TD-MERGE-43): the request
// payload's amount, the chain basis amount, the command params' amount and the adjustment record's
// amount are sent only to a holder of platform:billing:read AND platform:billing:amount:read;
// every other caller gets them omitted with `amount_withheld: "FINANCE_SCOPE_REQUIRED"`.
// No console mutation beyond the governed apply (PLATFORM-UX-1 A1-2).

@Controller('platform/commercial/change-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialBillingAdjustmentController {
  constructor(private readonly adjustments: CommercialBillingAdjustmentService) {}

  @Post(':id/billing-adjustment')
  @HttpCode(200)
  @RequireScopes('platform:approval:read')
  async applyAdjustment(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto; adjustment: BillingAdjustmentDto; replayed: boolean }> {
    assertPlatformTier(auth, requestId);
    try {
      const out = await this.adjustments.apply(
        { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes },
        id,
        { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId },
      );
      return { request: adjustmentRequestDto(out.request, financeReader(auth)), adjustment: billingAdjustmentDto(out, amountAccess(auth)), replayed: out.replayed };
    } catch (err) {
      throw adjustmentHttpError(err, requestId, amountAccess(auth));
    }
  }

  /**
   * CCP-C4-R (Architect C4 disposition, TD-C4-12) — the governed terminal resolution of an APPLYING
   * REFUND by its requester: reconcile first (an authoritative provider read); a confirmed refund is
   * recorded APPLIED; only a refund proven not to exist or unable to complete is resolved
   * (APPLYING → WITHDRAWN, one audit event, the slot released on commit). Uncertain → 409, held.
   */
  @Post(':id/billing-adjustment/resolve')
  @HttpCode(200)
  @RequireScopes('platform:approval:read')
  async resolveRefund(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto; adjustment: BillingAdjustmentDto; resolution: string; outcomes: string[] }> {
    assertPlatformTier(auth, requestId);
    try {
      const out = await this.adjustments.resolveRefund(
        { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes },
        id,
        { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId },
      );
      return { request: adjustmentRequestDto(out.request, financeReader(auth)), adjustment: billingAdjustmentDto(out, amountAccess(auth)), resolution: out.resolution, outcomes: [...out.outcomes] };
    } catch (err) {
      throw adjustmentHttpError(err, requestId, amountAccess(auth));
    }
  }

  @Get(':id/billing-adjustment')
  @RequireScopes('platform:approval:read')
  async read(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto; adjustment: BillingAdjustmentDto }> {
    assertPlatformTier(auth, requestId);
    try {
      const view = await this.adjustments.view(id);
      return { request: adjustmentRequestDto(view.request, financeReader(auth)), adjustment: billingAdjustmentDto(view, amountAccess(auth)) };
    } catch (err) {
      throw adjustmentHttpError(err, requestId, amountAccess(auth));
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

/**
 * CCP-R3-W item 3 (TD-MERGE-43 residual): every refusal / failure of a C4 route (REFUND_REMAINDER_UNVERIFIABLE
 * basis provider_read_failed, REFUND_OUTCOME_UNCERTAIN, an UNEXPECTED apply failure) keeps its code,
 * refusal and explanation; its provider-derived text (`error`, `message`) reaches only a holder of the
 * Finance amount scope, a non-holder (the requester included) gets `detail_withheld`.
 */
function adjustmentHttpError(err: unknown, requestId: string, amount_access: boolean): unknown {
  return withholdErrorProviderText(adjustmentHttpErrorOf(err, requestId, amount_access), amount_access);
}

function adjustmentHttpErrorOf(err: unknown, requestId: string, amount_access: boolean): unknown {
  if (err instanceof BillingAdjustmentRefusedError) {
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', `apply refused: ${err.reason}`, 409, {
      requestId,
      details: { reason: 'apply_refused', refusal: err.reason, explanation: explanationOf(err.reason), ...err.detail },
    });
  }
  if (err instanceof CommercialChangeRequestError && err.code === 'ACTION_NOT_APPLICABLE') {
    return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'action_not_applicable', explanation: explanationOf(err.code), ...err.details } });
  }
  return applyHttpError(err, requestId, amount_access);
}

/** The change-request read of a C4 route: R3's shared redaction (payload and chain basis) applies. */
export function adjustmentRequestDto(r: CommercialChangeRequestRow, reader: FinanceReader): CommercialChangeRequestDto {
  return requestDto(r, reader);
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function billingAdjustmentDto(v: BillingAdjustmentView, amount_access: boolean): BillingAdjustmentDto {
  const a = v.adjustment;
  return {
    operation: v.operation,
    status: v.status,
    pending_provider: v.pending_provider,
    refund_execution_disabled: v.refund_execution_disabled,
    commands: v.commands.map((c) => billingCommandDto(c, amount_access)),
    record:
      a === null
        ? null
        : {
            id: a.id,
            change_request_id: a.change_request_id,
            action_type: a.action_type,
            operation: a.operation,
            tenant_id: a.tenant_id,
            product_key: a.product_key,
            subscription_id: a.subscription_id,
            provider: a.provider,
            provider_target_ref: a.provider_target_ref,
            provider_object_ref: a.provider_object_ref,
            discount_bps: a.discount_bps,
            compensates_change_request_id: a.compensates_change_request_id,
            command_id: a.command_id,
            confirmation_source: a.confirmation_source,
            confirmation_event_id: a.confirmation_event_id,
            attempt: a.attempt,
            requested_by: a.requested_by,
            applied_at: (iso(a.applied_at) as string),
            ...(a.amount_minor === null ? {} : amount_access ? { amount_minor: Number(a.amount_minor), currency: a.currency } : { amount_withheld: 'FINANCE_SCOPE_REQUIRED' as const }),
          },
  };
}
