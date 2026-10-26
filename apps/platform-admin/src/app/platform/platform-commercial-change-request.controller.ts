import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, PLATFORM_TENANT_SENTINEL_ID, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  CommercialApprovalRefusedError,
  CommercialChangeRequestCursorError,
  CommercialChangeRequestError,
  CommercialChangeRequestService,
  CommercialNotBootstrappedError,
  CommercialPolicyUnavailableError,
  type ChangeRequestView,
  type CommercialActor,
  type CommercialApprovalRow,
  type CommercialCallContext,
  type CommercialChangeRequestRow,
  withholdChangeRequestAmounts,
} from '@aramo/subscription';

import {
  ApproveCommercialChangeRequestDto,
  type CommercialApprovalDto,
  type CommercialChangeRequestDetailDto,
  type CommercialRoleChangeApplyDto,
  type CommercialChangeRequestDto,
  CreateCommercialChangeRequestDto,
  ListCommercialChangeRequestsQueryDto,
  RejectCommercialChangeRequestDto,
} from './dto/commercial-change-request.dto.js';
import { amountAccess } from './finance-amount-access.js';

// CCP-A3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A3) — the commercial
// change-request and approval surface. Platform consumer only (the DDR §13.1 tripwire).
//
// Route gate: `platform:approval:read`, held by all 6 CCP roles and never by super_admin
// (CCP A1 §4.1; INV-1, PBD §12), so super_admin is refused on every route. Below the gate
// the service is the authority:
//   create        the action's requester scope (A1 §4.1: subscription/entitlement/billing
//                 :request, catalog:draft, subscription:support); CCP-A9 (TD-A3-5): governance
//                 actions need the live requester ROLE plus a D9 attestation — POLICY_ACTIVATE
//                 a finance_admin, ROLE_GRANT / ROLE_REVOKE a platform_owner (the governed
//                 role-change endpoint, pre-execution C-3)
//   submit/withdraw  the requester only
//   approve/reject   live eligibility in the transaction: the seven refusals; approve also
//                 runs the chain-satisfiability gate (409 CCP_NOT_BOOTSTRAPPED)
// Every act writes CommercialAuditEvent rows (CCP-A2 stream). CCP-A9: an approval that
// completes a ROLE_GRANT / ROLE_REVOKE chain applies the role change right after (the
// response carries `apply`); nothing else is applied (A6). CCP-B5-R (TD-B5-1): an approved
// POLICY_ACTIVATE is applied by its requester through POST …/{id}/apply (APPROVED → APPLYING →
// APPLIED); the B5 `effect_applied_at` field is dropped (`applied_at` is the record).

@Controller('platform/commercial/change-requests')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialChangeRequestController {
  constructor(private readonly service: CommercialChangeRequestService) {}

  @Post()
  @RequireScopes('platform:approval:read')
  async create(
    @Body() body: CreateCommercialChangeRequestDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ request: CommercialChangeRequestDto; replayed: boolean }> {
    this.platformOnly(auth, requestId);
    const out = await this.run(requestId, () =>
      this.service.create(
        actorOf(auth),
        {
          action_type: body.action_type,
          kind: body.kind,
          tenant_id: body.tenant_id ?? null,
          product_key: body.product_key ?? null,
          payload: body.payload,
          reason: body.reason,
          idempotency_key: body.idempotency_key,
        },
        ctxOf(requestId),
      ),
    );
    res.status(out.replayed ? 200 : 201);
    return { request: requestDto(out.request, amountAccess(auth)), replayed: out.replayed };
  }

  @Get()
  @RequireScopes('platform:approval:read')
  async list(
    @Query() query: ListCommercialChangeRequestsQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ requests: CommercialChangeRequestDto[]; next_cursor: string | null }> {
    this.platformOnly(auth, requestId);
    const page = await this.run(requestId, () =>
      this.service.list(
        actorOf(auth),
        {
          state: query.state,
          requested_by: query.requester === 'me' ? auth.sub : query.requester,
          eligible_for_me: query.eligible_for_me === 'true',
          limit: query.limit,
          cursor: query.cursor,
        },
        ctxOf(requestId),
      ),
    );
    return { requests: page.requests.map((r) => requestDto(r, amountAccess(auth))), next_cursor: page.next_cursor };
  }

  @Get(':id')
  @RequireScopes('platform:approval:read')
  async get(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<CommercialChangeRequestDetailDto> {
    this.platformOnly(auth, requestId);
    return detailDto(await this.run(requestId, () => this.service.get(actorOf(auth), id, ctxOf(requestId))), amountAccess(auth));
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequireScopes('platform:approval:read')
  async submit(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ request: CommercialChangeRequestDto }> {
    this.platformOnly(auth, requestId);
    return { request: requestDto(await this.run(requestId, () => this.service.submit(actorOf(auth), id, ctxOf(requestId))), amountAccess(auth)) };
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @RequireScopes('platform:approval:read')
  async withdraw(@Param('id', new ParseUUIDPipe()) id: string, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ request: CommercialChangeRequestDto }> {
    this.platformOnly(auth, requestId);
    return { request: requestDto(await this.run(requestId, () => this.service.withdraw(actorOf(auth), id, ctxOf(requestId))), amountAccess(auth)) };
  }

  @Post(':id/approvals')
  @HttpCode(201)
  @RequireScopes('platform:approval:read')
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ApproveCommercialChangeRequestDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto; approval: CommercialApprovalDto; apply: CommercialRoleChangeApplyDto | null }> {
    this.platformOnly(auth, requestId);
    const out = await this.run(requestId, () => this.service.approve(actorOf(auth), id, { step_index: body.step_index, comment: body.comment ?? null }, ctxOf(requestId)));
    const apply = out.apply ?? null;
    return {
      request: requestDto(out.request, amountAccess(auth)),
      approval: approvalDto(out.approval),
      apply: apply === null ? null : { applied: apply.applied, reason: apply.reason, detail: apply.detail },
    };
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequireScopes('platform:approval:read')
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RejectCommercialChangeRequestDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ request: CommercialChangeRequestDto }> {
    this.platformOnly(auth, requestId);
    return { request: requestDto(await this.run(requestId, () => this.service.reject(actorOf(auth), id, { reason: body.reason }, ctxOf(requestId))), amountAccess(auth)) };
  }

  private platformOnly(auth: AuthContextType, requestId: string): void {
    if (auth.consumer_type !== 'platform') {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
        requestId,
        details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
      });
    }
  }

  private async run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw toAramoError(err, requestId);
    }
  }
}

function actorOf(auth: AuthContextType): CommercialActor {
  return { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes };
}

function ctxOf(requestId: string): CommercialCallContext {
  return { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId };
}

export function toAramoError(err: unknown, requestId: string): unknown {
  if (err instanceof CommercialApprovalRefusedError) {
    return new AramoError('COMMERCIAL_APPROVAL_REFUSED', `approval refused: ${err.refusal}`, 409, { requestId, details: { refusal: err.refusal, ...err.detail } });
  }
  if (err instanceof CommercialNotBootstrappedError) {
    return new AramoError('CCP_NOT_BOOTSTRAPPED', err.message, 409, { requestId, details: err.detail });
  }
  if (err instanceof CommercialPolicyUnavailableError) {
    return new AramoError('COMMERCIAL_POLICY_UNAVAILABLE', 'no valid ACTIVE commercial policy', 503, { requestId, details: { reason: err.reason } });
  }
  if (err instanceof CommercialChangeRequestCursorError) {
    return new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'invalid_cursor' } });
  }
  if (err instanceof CommercialChangeRequestError) {
    const d = err.details;
    switch (err.code) {
      case 'NOT_FOUND':
        return new AramoError('NOT_FOUND', err.message, 404, { requestId, details: d });
      case 'REQUESTER_SCOPE_MISSING':
        return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'requester_scope_missing', ...d } });
      case 'REQUESTER_ROLE_MISSING':
        return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'requester_role_missing', ...d } });
      case 'LAST_OWNER':
        return new AramoError('PLATFORM_LAST_OWNER', err.message, 409, { requestId, details: { reason: 'platform_last_owner' } });
      case 'REQUESTER_AUTHORITY_UNDEFINED':
        return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'requester_authority_undefined', ...d } });
      case 'NOT_REQUESTER':
        return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'not_requester' } });
      case 'NOT_HUMAN':
        return new AramoError('INSUFFICIENT_PERMISSIONS', err.message, 403, { requestId, details: { reason: 'not_human' } });
      case 'KIND_NOT_SUPPORTED':
        return new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'kind_not_supported', ...d } });
      case 'INVALID_INPUT':
        return new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: d });
      case 'TENANT_NOT_FOUND':
        return new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: 'tenant_not_found', ...d } });
      case 'IDEMPOTENCY_KEY_CONFLICT':
        return new AramoError('IDEMPOTENCY_KEY_CONFLICT', err.message, 409, { requestId, details: d });
      case 'OPEN_REQUEST_EXISTS':
        return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'open_request_exists', ...d } });
      case 'STATE_INVALID':
        return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'state_invalid', ...d } });
      case 'INTEGRITY':
        return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'integrity', ...d } });
      case 'SUPPORT_EXTENSION_INELIGIBLE':
        // CCP-R3 (TD-A8-3 refined): an eligibility refusal, audited; nothing applied or escalated.
        return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { ...d, reason: 'support_extension_ineligible' } });
      // CCP-C4-P (Amendment A1 RF-3…RF-5) — details.refusal: REFUND_EXCEEDS_REMAINDER |
      // REFUND_PAYMENT_DISPUTED | REFUND_REMAINDER_UNVERIFIABLE | REFUND_PAYMENT_MISMATCH | REFUND_CURRENCY_MISMATCH.
      case 'REFUND_NOT_REFUNDABLE':
        return new AramoError('COMMERCIAL_CHANGE_REQUEST_CONFLICT', err.message, 409, { requestId, details: { reason: 'refund_not_refundable', ...d } });
    }
  }
  return err;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function requestDto(r: CommercialChangeRequestRow, amount_access: boolean): CommercialChangeRequestDto {
  const chain = r.required_chain as CommercialChangeRequestDto['required_chain'];
  return {
    id: r.id,
    action_type: r.action_type,
    kind: r.kind,
    state: r.state,
    tenant_id: r.tenant_id,
    product_key: r.product_key,
    // CCP-R3 (CCP-A1 Amendment A1, FA-1 / FA-5; TD-C4-7): a monetary action's (CREDIT, DISCOUNT,
    // REFUND) tenant-specific amount is sent only to
    // a caller holding platform:billing:read AND platform:billing:amount:read; otherwise it is
    // omitted from the payload and the chain basis (`amount_withheld: "FINANCE_SCOPE_REQUIRED"`).
    // payload_checksum stays the stored row's checksum (over the full payload).
    payload: withholdChangeRequestAmounts(r.action_type, (r.payload ?? {}) as Record<string, unknown>, amount_access),
    payload_checksum: r.payload_checksum,
    required_chain: { rule: chain.rule, basis: withholdChangeRequestAmounts(r.action_type, chain.basis ?? {}, amount_access), steps: chain.steps },
    policy_version_id: r.policy_version_id,
    policy_checksum: r.policy_checksum,
    requested_by: r.requested_by,
    reason: r.reason,
    created_at: r.created_at.toISOString(),
    submitted_at: iso(r.submitted_at),
    expires_at: iso(r.expires_at),
    approved_at: iso(r.approved_at),
    rejected_at: iso(r.rejected_at),
    rejected_by: r.rejected_by,
    rejection_reason: r.rejection_reason,
    withdrawn_at: iso(r.withdrawn_at),
    expired_at: iso(r.expired_at),
    applied_at: iso(r.applied_at ?? null),
  };
}

export function approvalDto(a: CommercialApprovalRow): CommercialApprovalDto {
  return {
    id: a.id,
    step_index: a.step_index,
    approver_user_id: a.approver_user_id,
    step_role_key: a.step_role_key,
    step_scope_keys: a.step_scope_keys,
    approver_role_keys: a.approver_role_keys,
    comment: a.comment,
    created_at: a.created_at.toISOString(),
  };
}

function detailDto(v: ChangeRequestView, amount_access: boolean): CommercialChangeRequestDetailDto {
  return {
    request: requestDto(v.request, amount_access),
    approvals: v.approvals.map(approvalDto),
    is_expired: v.is_expired,
    chain_satisfiable: v.chain_satisfiable,
    // CCP-A6-R (TD-B2-3) — true only for the requester of an APPROVED / APPLY_FAILED applicable request.
    apply_actionable: v.apply_actionable,
    steps: v.steps.map((s) => ({
      step_index: s.step_index,
      role_key: s.role_key,
      scope_keys: s.scope_keys,
      status: s.status,
      approval_id: s.approval?.id ?? null,
      caller: s.caller,
    })),
  };
}
