import { Body, Controller, Get, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, PLATFORM_TENANT_SENTINEL_ID, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { SupportExtensionService, type SupportExtensionOutcome, type SupportExtensionRow } from '@aramo/subscription';

import { RequestSupportExtensionDto, ListSupportExtensionsQueryDto, type SupportExtensionDto, type SupportExtensionOutcomeDto } from './dto/support-extension.dto.js';
import { applicationDto, applyHttpError } from './platform-commercial-apply.controller.js';
import { requestDto } from './platform-commercial-change-request.controller.js';

// CCP-A8 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A8; DDR v1.2 §3.2(5); Q7) — the
// support exception overlay. Platform consumer only (the DDR §13.1 tripwire).
//
//   POST /platform/commercial/support-extensions   gate `platform:subscription:support`
//        (support_admin only, A1 §4.1; never super_admin). In bounds → the bounded EXCEPTION is
//        applied in one transaction (201, outcome APPLIED, is_exception = true on every audit
//        event). Any breach (LENGTH, FREQUENCY, CUMULATIVE, ELIGIBILITY) → a NORMAL request is
//        created and submitted for Finance (201, outcome ESCALATED); nothing applies. A replay of
//        the same idempotency key → 200, replayed. Refusals: 400 validation / subscription_not_open
//        / tenant_not_found / platform_tenant; 403 requester_scope_missing / not_human; 409
//        open_request_exists / IDEMPOTENCY_KEY_CONFLICT; 503 COMMERCIAL_POLICY_UNAVAILABLE.
//   GET  /platform/commercial/support-extensions?tenant_id=…[&product_key=…]   gate
//        `platform:subscription:read` (platform_owner, finance_admin, commercial_ops,
//        support_admin, read_only_auditor; never super_admin): the overlays of a tenant, newest
//        first, with `active`.
// An escalated request is approved and applied through the existing change-request routes
// (POST …/change-requests/{id}/approvals, …/apply); an overlay is removed by a SUPPORT_EXTENSION
// change request with payload operation REMOVE through the same routes.

@Controller('platform/commercial/support-extensions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialSupportExtensionController {
  constructor(private readonly service: SupportExtensionService) {}

  @Post()
  @RequireScopes('platform:subscription:support')
  async request(
    @Body() body: RequestSupportExtensionDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SupportExtensionOutcomeDto> {
    platformOnly(auth, requestId);
    try {
      const out = await this.service.request(
        { user_id: auth.sub, actor_kind: auth.actor_kind, scopes: auth.scopes },
        {
          tenant_id: body.tenant_id,
          product_key: body.product_key,
          subscription_id: body.subscription_id,
          requested_days: body.requested_days,
          reason: body.reason,
          idempotency_key: body.idempotency_key,
        },
        { platform_tenant_id: PLATFORM_TENANT_SENTINEL_ID, correlation_id: requestId },
      );
      res.status(out.replayed ? 200 : 201);
      return outcomeDto(out);
    } catch (err) {
      throw applyHttpError(err, requestId);
    }
  }

  @Get()
  @RequireScopes('platform:subscription:read')
  async list(@Query() query: ListSupportExtensionsQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<{ extensions: SupportExtensionDto[] }> {
    platformOnly(auth, requestId);
    try {
      const rows = await this.service.list(query.tenant_id, query.product_key);
      return { extensions: rows.map((r) => ({ ...extensionDto(r), active: r.active })) };
    } catch (err) {
      throw applyHttpError(err, requestId);
    }
  }
}

function platformOnly(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function extensionDto(r: SupportExtensionRow): SupportExtensionDto {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    product_key: r.product_key,
    subscription_id: r.subscription_id,
    change_request_id: r.change_request_id,
    is_exception: r.is_exception,
    days: r.days,
    grace_until_at_apply: iso(r.grace_until_at_apply),
    base_until: r.base_until.toISOString(),
    extends_until: r.extends_until.toISOString(),
    policy_version_id: r.policy_version_id,
    applied_by: r.applied_by,
    applied_at: r.applied_at.toISOString(),
    removed_at: iso(r.removed_at),
    removed_by: r.removed_by,
    remove_change_request_id: r.remove_change_request_id,
  };
}

function outcomeDto(out: SupportExtensionOutcome): SupportExtensionOutcomeDto {
  return {
    outcome: out.outcome,
    replayed: out.replayed,
    request: requestDto(out.request),
    extension: out.outcome === 'APPLIED' ? extensionDto(out.extension) : null,
    application: out.outcome === 'APPLIED' ? applicationDto(out.application) : null,
    decision: out.decision === null ? null : { ...out.decision, clause: { ...out.decision.clause } },
  };
}
