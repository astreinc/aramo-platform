import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  BillingFinanceReportService,
  FINANCE_AMOUNT_WITHHELD,
  type HeldActivation,
  type OutstandingItem,
  type PriceFigure,
  type ReconciledSubscription,
  type RenewalItem,
} from '@aramo/subscription';

import {
  FinanceRenewalsQueryDto,
  FinanceReportQueryDto,
  type HeldActivationDto,
  type OutstandingItemDto,
  type OutstandingPaymentsResponseDto,
  type PriceFigureDto,
  type ReconciledSubscriptionDto,
  type ReconciliationReportResponseDto,
  type RenewalItemDto,
  type RenewalsResponseDto,
} from './dto/commercial-finance.dto.js';
import { amountAccess } from './finance-amount-access.js';

// CCP-C6 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C6; Conversion Rule C-8;
// PLATFORM-UX-1 Amendment A1-4a / ruling A0-C6) — the dedicated Finance READ routes: the renewals
// queue, outstanding payments and the billing reconciliation report (held activations included).
// platform:billing:read (CCP A1 §4.1: platform_owner, finance_admin, commercial_ops, support_admin,
// read_only_auditor; never catalog_manager, never super_admin). Platform consumer only. No mutation
// route: a held activation is resolved only through a governed conversion, a governed end or a
// provider-confirmed end (Conv. C-9), never from here.
//
//   GET finance/renewals               within_days (1..365, default 90), tenant_id, product_key
//   GET finance/outstanding-payments   tenant_id, product_key
//   GET finance/reconciliation-report  tenant_id, product_key

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

function price(p: PriceFigure): PriceFigureDto {
  return { list_price: p.list_price === null ? null : { ...p.list_price }, unpriced_reason: p.unpriced_reason, price_source: p.price_source, plan_version_id: p.plan_version_id };
}

export function renewalItemDto(i: RenewalItem): RenewalItemDto {
  return {
    subscription_id: i.subscription_id,
    tenant_id: i.tenant_id,
    tenant_name: i.tenant_name,
    product_key: i.product_key,
    source: i.source,
    status: i.status,
    plan_key: i.plan_key,
    plan_name: i.plan_name,
    version_number: i.version_number,
    grandfathered: i.grandfathered,
    renewal_kind: i.renewal_kind,
    renewal_at: i.renewal_at.toISOString(),
    days_until: i.days_until,
    lapsed: i.lapsed,
    commitment_months: i.commitment_months,
    cancel_at_period_end: i.cancel_at_period_end,
    cancel_requested_within_commitment: i.cancel_requested_within_commitment,
    ...price(i),
  };
}

export function outstandingItemDto(i: OutstandingItem, amount_access: boolean): OutstandingItemDto {
  return {
    subscription_id: i.subscription_id,
    tenant_id: i.tenant_id,
    tenant_name: i.tenant_name,
    product_key: i.product_key,
    source: i.source,
    status: i.status,
    plan_key: i.plan_key,
    version_number: i.version_number,
    billing_subscription_ref: i.billing_subscription_ref,
    status_since: iso(i.status_since),
    grace_until: iso(i.grace_until),
    grace_state: i.grace_state,
    current_period_end: iso(i.current_period_end),
    // CCP-R3 (CCP-A1 Amendment A1, FA-5): the amount owed is a tenant-specific figure.
    ...(amount_access ? { amount_due: null } : { amount_withheld: FINANCE_AMOUNT_WITHHELD }),
    amount_due_reason: i.amount_due_reason,
    ...price(i),
  };
}

function reconciledDto(s: ReconciledSubscription): ReconciledSubscriptionDto {
  return {
    subscription_id: s.subscription_id,
    tenant_id: s.tenant_id,
    tenant_name: s.tenant_name,
    product_key: s.product_key,
    source: s.source,
    status: s.status,
    plan_key: s.plan_key,
    version_number: s.version_number,
    version_status: s.version_status,
    grandfathered: s.grandfathered,
    billing_subscription_ref: s.billing_subscription_ref,
    provider_price_ref: s.provider_price_ref,
    entitlement: { expected: [...s.entitlement.expected], present: [...s.entitlement.present], missing: [...s.entitlement.missing] },
    open_flag_reasons: [...s.open_flag_reasons],
    unconfirmed_command_ids: [...s.unconfirmed_command_ids],
    discrepancies: [...s.discrepancies],
    ...price(s),
  };
}

function heldDto(h: HeldActivation): HeldActivationDto {
  return {
    flag_id: h.flag_id,
    tenant_id: h.tenant_id,
    tenant_name: h.tenant_name,
    product_key: h.product_key,
    provider: h.provider,
    subscription_ref: h.subscription_ref,
    detected_at: h.detected_at.toISOString(),
    intent_id: h.intent_id,
    intent_status: h.intent_status,
    governed_subscription_id: h.governed_subscription_id,
    governed_plan_key: h.governed_plan_key,
    held_plan_key: h.held_plan_key,
    held_price: price(h.held_price),
    unconfirmed_commands: h.unconfirmed_commands.map((c) => ({ ...c })),
    resolution: h.resolution,
  };
}

@Controller('platform/commercial/finance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialFinanceController {
  constructor(private readonly reports: BillingFinanceReportService) {}

  @Get('renewals')
  @RequireScopes('platform:billing:read')
  async renewals(@Query() query: FinanceRenewalsQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<RenewalsResponseDto> {
    assertPlatform(auth, requestId);
    const r = await this.reports.renewals({ tenant_id: query.tenant_id, product_key: query.product_key, within_days: query.within_days });
    return { as_of: r.as_of.toISOString(), within_days: r.within_days, currency: r.currency, billing_provider_mode: r.billing_provider_mode, tax: { ...r.tax }, items: r.items.map(renewalItemDto), counts: { ...r.counts } };
  }

  @Get('outstanding-payments')
  @RequireScopes('platform:billing:read')
  async outstanding(@Query() query: FinanceReportQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<OutstandingPaymentsResponseDto> {
    assertPlatform(auth, requestId);
    const r = await this.reports.outstandingPayments({ tenant_id: query.tenant_id, product_key: query.product_key });
    return { as_of: r.as_of.toISOString(), currency: r.currency, billing_provider_mode: r.billing_provider_mode, tax: { ...r.tax }, items: r.items.map((i) => outstandingItemDto(i, amountAccess(auth))), counts: { ...r.counts } };
  }

  @Get('reconciliation-report')
  @RequireScopes('platform:billing:read')
  async reconciliation(@Query() query: FinanceReportQueryDto, @AuthContext() auth: AuthContextType, @RequestId() requestId: string): Promise<ReconciliationReportResponseDto> {
    assertPlatform(auth, requestId);
    const r = await this.reports.reconciliationReport({ tenant_id: query.tenant_id, product_key: query.product_key });
    return {
      as_of: r.as_of.toISOString(),
      currency: r.currency,
      billing_provider_mode: r.billing_provider_mode,
      tax: { ...r.tax },
      status: r.status,
      subscriptions: r.subscriptions.map(reconciledDto),
      entitled_without_subscription: r.entitled_without_subscription.map((e) => ({
        tenant_id: e.tenant_id,
        tenant_name: e.tenant_name,
        product_key: e.product_key,
        capabilities: [...e.capabilities],
        residual_authority: e.residual_authority,
        residual_authority_until: iso(e.residual_authority_until),
      })),
      held_activations: r.held_activations.map(heldDto),
      other_open_flags: r.other_open_flags.map((f) => ({ ...f, detected_at: f.detected_at.toISOString() })),
      // CCP-C8-PR (PAYMENT_RECORD §4.3 step 5) — unlinked prepaid INITIAL receipts (no amount).
      unlinked_receipts: r.unlinked_receipts.map((u) => ({ ...u, recorded_at: u.recorded_at.toISOString() })),
      counts: { ...r.counts, by_source: { ...r.counts.by_source }, by_status: { ...r.counts.by_status }, discrepancies: { ...r.counts.discrepancies } },
    };
  }
}
