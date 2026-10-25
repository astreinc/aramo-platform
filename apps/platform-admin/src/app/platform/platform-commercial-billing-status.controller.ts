import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { AramoError, RequestId } from '@aramo/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import {
  BillingStatusQueryError,
  BillingStatusReadService,
  type BillingPortalConfigurationStatus,
  type BillingStatusInvoice,
  type TenantBillingStatus,
} from '@aramo/subscription';

import {
  BillingPortalConfigurationQueryDto,
  TenantBillingStatusQueryDto,
  type BillingPortalConfigurationResponseDto,
  type BillingStatusInvoiceDto,
  type TenantBillingStatusResponseDto,
} from './dto/commercial-billing-status.dto.js';

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
//       invoices with a payment state. Money appears here only (A1-4a: a dedicated billing
//       screen, never the dashboard).
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

export function tenantBillingStatusDto(s: TenantBillingStatus): TenantBillingStatusResponseDto {
  return {
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
    invoices: s.invoices.map(invoiceDto),
    tax: { enabled: s.tax.enabled, reason: s.tax.reason },
    detail: s.detail,
    read_at: s.read_at.toISOString(),
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
  constructor(private readonly status: BillingStatusReadService) {}

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
      return tenantBillingStatusDto(await this.status.tenantBillingStatus(tenant_id, query.product_key, { invoice_limit: query.invoice_limit }));
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
