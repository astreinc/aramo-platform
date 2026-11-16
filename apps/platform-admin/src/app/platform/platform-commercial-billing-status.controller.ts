import { Controller, Get, Optional, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  BILLING_STATUS_DEFAULT_INVOICE_LIMIT,
  BILLING_STATUS_MAX_INVOICE_LIMIT,
  BillingStatusQueryError,
  BillingStatusReadService,
  FINANCE_AMOUNT_WITHHELD,
  paymentFlags,
  SIGN_PRODUCT_KEY,
  BillingProductsService,
  type MismatchEntry,
  StoreBillingService,
  type StorePriceReconciliationEntry,
  type BillingPortalConfigurationStatus,
  type BillingStatusInvoice,
  type TenantBillingStatus,
  RefundablePaymentsService,
  type RefundablePayments,
} from '@aramo/subscription';

import {
  BillingPortalConfigurationQueryDto,
  RefundablePaymentsQueryDto,
  TenantBillingStatusQueryDto,
  type RefundablePaymentsResponseDto,
  type BillingPortalConfigurationResponseDto,
  type BillingStatusInvoiceDto,
  type TenantBillingStatusResponseDto,
} from './dto/commercial-billing-status.dto.js';
import { amountAccess } from './finance-amount-access.js';

// CCP-C3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C3; Charter §3 "mirror status
// only"; Charter §4 L5) — READ-THROUGH invoice and payment status, and the billing-portal
// configuration facts. READ-ONLY: both routes are GET and reach the provider only through the
// GET-only read adapter (BILLING_PROVIDER_READ_PORT). There is no mutation route (PLATFORM-UX-1
// A1-2); invoices and payment methods stay managed in the Stripe hosted portal (L5).
//
// Scope platform:billing:read (CCP A1 §4.1 matrix; reserved for "Phase C (C3/C4)", A1 :317):
// platform_owner, finance_admin, commercial_ops, support_admin, read_only_auditor. Never
// catalog_manager, never super_admin. Platform consumer only.
//
//   GET tenants/{tenant_id}/billing-status?product_key=sign[&invoice_limit=n]
//       the tenant's Stripe-owned subscription for the product, its provider status and its
//       invoices with a payment state. CCP-R3 (CCP-A1 Amendment A1): the invoices (amounts,
//       currency, hosted page / PDF links) need platform:billing:amount:read too; without it the
//       field is absent and `amount_withheld: "FINANCE_SCOPE_REQUIRED"` is set. Every caller gets
//       the derived payment_due / payment_overdue booleans (FA-4).
//   GET billing-portal-configuration
//       STRIPE_PORTAL_CONFIGURATION and what the provider holds for it. ACTIVE is a provider
//       fact only. It is NOT the PBD §10 verification of the external decision.
// Disabled states are `availability` values (R-13), never a 5xx.

function assertPlatform(auth: AuthContextType, requestId: string): void {
  if (auth.consumer_type !== 'platform') {
    throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Platform routes require consumer_type=platform', 403, {
      requestId,
      details: { reason: 'tier_mismatch', consumer_type: auth.consumer_type },
    });
  }
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

// CCP-R3 (CCP-A1 Amendment A1, FA-1 / FA-4 / FA-5) — the invoice list (amounts, currency, links
// that display them) is sent only to a caller holding platform:billing:read AND
// platform:billing:amount:read. Every platform:billing:read holder receives the two derived booleans
// payment_due / payment_overdue, and nothing they could be reconstructed from: without the amount
// scope there is no `invoices` field at all (no count, currency, line or link), and the provider
// error text is replaced by a fixed line (FA-6: no leakage through error messages).
function invoiceDto(i: BillingStatusInvoice): BillingStatusInvoiceDto {
  return {
    provider: i.provider,
    invoice_ref: i.invoice_ref,
    number: i.number,
    subscription_ref: i.subscription_ref,
    provider_status: i.provider_status,
    payment_state: i.payment_state,
    currency: i.currency,
    total_minor: i.total_minor,
    amount_due_minor: i.amount_due_minor,
    amount_paid_minor: i.amount_paid_minor,
    amount_remaining_minor: i.amount_remaining_minor,
    created_at: iso(i.created_at),
    due_at: iso(i.due_at),
    period_start: iso(i.period_start),
    period_end: iso(i.period_end),
    attempt_count: i.attempt_count,
    next_attempt_at: iso(i.next_attempt_at),
    hosted_url: i.hosted_url,
    document_url: i.document_url,
  };
}

/** FA-6: the provider's own error text never reaches a caller without the amount scope. */
export const PROVIDER_UNAVAILABLE_DETAIL_WITHHELD = 'the billing provider could not be read';

export function tenantBillingStatusDto(s: TenantBillingStatus, amount_access: boolean, invoice_limit: number = BILLING_STATUS_DEFAULT_INVOICE_LIMIT): TenantBillingStatusResponseDto {
  const flags = paymentFlags(s.invoices.map((i) => i.payment_state));
  const common = {
    tenant_id: s.tenant_id,
    product_key: s.product_key,
    availability: s.availability,
    provider: s.provider,
    mode: s.mode,
    subscription: s.subscription,
    provider_subscription:
      s.provider_subscription === null
        ? null
        : {
            provider_status: s.provider_subscription.provider_status,
            current_period_start: s.provider_subscription.current_period_start.toISOString(),
            current_period_end: s.provider_subscription.current_period_end.toISOString(),
            cancel_at_period_end: s.provider_subscription.cancel_at_period_end,
          },
    payment_due: flags.payment_due,
    payment_overdue: flags.payment_overdue,
    tax: { enabled: s.tax.enabled, reason: s.tax.reason },
    read_at: s.read_at.toISOString(),
  };
  if (amount_access) return { ...common, invoices: s.invoices.slice(0, invoice_limit).map(invoiceDto), detail: s.detail };
  return {
    ...common,
    amount_withheld: FINANCE_AMOUNT_WITHHELD,
    detail: s.availability === 'PROVIDER_UNAVAILABLE' && s.detail !== null ? PROVIDER_UNAVAILABLE_DETAIL_WITHHELD : s.detail,
  };
}

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 1 — dates as ISO strings; every
// field is a Finance amount-holder field (the route refuses anyone else).
export function refundablePaymentsDto(r: RefundablePayments): RefundablePaymentsResponseDto {
  return {
    tenant_id: r.tenant_id,
    product_key: r.product_key,
    availability: r.availability,
    mode: r.mode,
    subscription_id: r.subscription_id,
    payments: r.payments.map((p) => ({
      invoice_ref: p.invoice_ref,
      number: p.number,
      payment_ref: p.payment_ref,
      currency: p.currency,
      amount_paid_minor: p.amount_paid_minor,
      created_at: iso(p.created_at),
      period_start: iso(p.period_start),
      period_end: iso(p.period_end),
      refunded_minor: p.refunded_minor,
      reserved_minor: p.reserved_minor,
      disputed_lost_minor: p.disputed_lost_minor,
      remainder_minor: p.remainder_minor,
      refusal: p.refusal,
      live: p.live,
    })),
    detail: r.detail,
    read_at: r.read_at.toISOString(),
  };
}

export function billingPortalConfigurationDto(s: BillingPortalConfigurationStatus): BillingPortalConfigurationResponseDto {
  return {
    provider: s.provider,
    availability: s.availability,
    mode: s.mode,
    configuration_ref: s.configuration_ref,
    configuration_state: s.configuration_state,
    configuration: s.configuration,
    detail: s.detail,
    read_at: s.read_at.toISOString(),
  };
}

@Controller('platform/commercial')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PlatformCommercialBillingStatusController {
  constructor(
    private readonly status: BillingStatusReadService,
    // M-A12 A1-3 — the store price reconciliation (SubscriptionModule provides it).
    @Optional() private readonly store?: StoreBillingService,
    // CCP Billing Products BP-12 — the all-channel price-mismatch report (US price included).
    @Optional() private readonly billingProducts?: BillingProductsService,
    // Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 1.
    @Optional() private readonly refundable?: RefundablePaymentsService,
  ) {}

  /**
   * Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 1 — the refundable payments of the
   * tenant's OPEN self-service subscription: each paid invoice's payment id, provider refunds, Aramo
   * outstanding refund requests and the refundable remainder, decided by the existing remainder rule
   * (Amendment A1 RF-3..RF-5). READ-ONLY. Every row is a tenant monetary figure. Readers: a Finance
   * amount holder (platform:billing:read AND platform:billing:amount:read; CCP-R3 FA-1), or — the
   * narrow FA-1 exception of Console Refund Request Amendment A2 (A2-3) — a refund requester
   * (platform:billing:read AND platform:billing:request, i.e. commercial_ops), who authors the refund
   * amount and so may see what is refundable on THIS route only. Anyone else is refused 403.
   */
  @Get('tenants/:tenant_id/refundable-payments')
  @RequireScopes('platform:billing:read')
  async refundablePayments(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @Query() query: RefundablePaymentsQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<RefundablePaymentsResponseDto> {
    assertPlatform(auth, requestId);
    if (!amountAccess(auth) && !auth.scopes.includes('platform:billing:request')) {
      throw new AramoError('INSUFFICIENT_PERMISSIONS', 'Refundable payments need the Finance amount permission or the refund request permission', 403, {
        requestId,
        details: { reason: 'refundable_payments_scope_required', required_scope_any: ['platform:billing:amount:read', 'platform:billing:request'] },
      });
    }
    if (this.refundable === undefined) throw new AramoError('INTERNAL_ERROR', 'refundable payments are not available in this service', 500, { requestId });
    try {
      return refundablePaymentsDto(await this.refundable.list(tenant_id, query.product_key));
    } catch (err) {
      if (err instanceof BillingStatusQueryError) {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: err.code.toLowerCase() } });
      }
      throw err;
    }
  }

  /**
   * Aramo Sign Mobile M-A12 Amendment A1-3 — the reconciliation report: every store product pinned to a
   * PUBLISHED plan version against the version's published regional prices (MATCH / MISMATCH /
   * NO_REGIONAL_PRICE / NOT_IN_STORE / STORE_PRICE_UNAVAILABLE). Read only: nothing is blocked at
   * runtime (the store always charges its own localized price).
   */
  @Get('store-price-reconciliation')
  @RequireScopes('platform:billing:read')
  async storePriceReconciliation(
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<{ product_key: string; entries: StorePriceReconciliationEntry[]; billing_products: MismatchEntry[] }> {
    assertPlatform(auth, requestId);
    return {
      product_key: SIGN_PRODUCT_KEY,
      entries: this.store === undefined ? [] : await this.store.priceReconciliation(SIGN_PRODUCT_KEY),
      // CCP Billing Products BP-12 — every billing product (Stripe, App Store, Google Play) of every published
      // version: catalog price vs the channel's live price, US included. Additive field; reports only.
      billing_products: this.billingProducts === undefined ? [] : await this.billingProducts.mismatchReport(),
    };
  }

  @Get('tenants/:tenant_id/billing-status')
  @RequireScopes('platform:billing:read')
  async tenantBillingStatus(
    @Param('tenant_id', new ParseUUIDPipe()) tenant_id: string,
    @Query() query: TenantBillingStatusQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<TenantBillingStatusResponseDto> {
    assertPlatform(auth, requestId);
    try {
      // FA-4: the booleans are derived from the same fixed window (the newest
      // BILLING_STATUS_MAX_INVOICE_LIMIT invoices) for every caller, so invoice_limit cannot be
      // used to probe how many invoices are open; holders get the first invoice_limit of them.
      const s = await this.status.tenantBillingStatus(tenant_id, query.product_key, { invoice_limit: BILLING_STATUS_MAX_INVOICE_LIMIT });
      return tenantBillingStatusDto(s, amountAccess(auth), query.invoice_limit ?? BILLING_STATUS_DEFAULT_INVOICE_LIMIT);
    } catch (err) {
      if (err instanceof BillingStatusQueryError) {
        throw new AramoError('VALIDATION_ERROR', err.message, 400, { requestId, details: { reason: err.code.toLowerCase() } });
      }
      throw err;
    }
  }

  @Get('billing-portal-configuration')
  @RequireScopes('platform:billing:read')
  async portalConfiguration(
    // Rejects any query parameter (400): the configuration id is never caller-supplied.
    @Query() _query: BillingPortalConfigurationQueryDto,
    @AuthContext() auth: AuthContextType,
    @RequestId() requestId: string,
  ): Promise<BillingPortalConfigurationResponseDto> {
    assertPlatform(auth, requestId);
    return billingPortalConfigurationDto(await this.status.portalConfigurationStatus());
  }
}
