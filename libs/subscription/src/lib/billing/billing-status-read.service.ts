import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { assertProductKey, type ProductKey } from '../product-registry.js';

import {
  BILLING_PROVIDER_READ_PORT,
  type BillingProviderKey,
  type BillingProviderReadPort,
  type ProviderInvoiceState,
  type ProviderPortalConfigurationState,
} from './billing-provider.port.js';

// CCP-C3 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C3; Charter §3 "Payments,
// invoices … | Stripe | Aramo SHALL mirror status only. Aramo SHALL NOT build a competing payment
// ledger"; Charter §4 L5) — READ-THROUGH invoice and payment status for a tenant's Stripe-owned
// (SELF_SERVICE) subscription, and the billing-portal configuration facts.
//
//   - Reads the provider through BILLING_PROVIDER_READ_PORT only (StripeBillingReadAdapter: GET
//     only). Nothing is written: no local table and no provider object. No figure is stored,
//     totalled or derived beyond a per-invoice payment state (no ledger).
//   - Product-scoped (MP-A2 N-11): every read names the product, and invoices are listed by the
//     product's subscription, never by billing account, so another product's invoices on the
//     same account are never read (N-12).
//   - Tenant isolation: the provider subscription must carry this tenant's id in its metadata
//     and the local billing account. Each invoice must belong to that account and subscription.
//     Any mismatch is refused as TENANT_MISMATCH, and no provider data is returned.
//   - Designed disabled states (PLATFORM-UX-1 R-13; PBD §5.2 "Stripe test mode with designed
//     disabled states"): an unconfigured provider, a live-mode key (held: Phase C runs in test
//     mode; the live-billing release authorization lifts it), no Stripe-owned subscription, and
//     a failed provider read are each an `availability` value, never a 5xx.
//   - Money (PLATFORM-UX-1 A1-4a): invoice amounts are returned only by tenantBillingStatus,
//     which serves a dedicated billing (Finance) screen. They never feed a dashboard or an
//     aggregate.

export const BILLING_STATUS_AVAILABILITY = ['AVAILABLE', 'BILLING_UNAVAILABLE', 'LIVE_MODE_HELD', 'NO_PROVIDER_SUBSCRIPTION', 'PROVIDER_UNAVAILABLE', 'TENANT_MISMATCH'] as const;
export type BillingStatusAvailability = (typeof BILLING_STATUS_AVAILABILITY)[number];

export const INVOICE_PAYMENT_STATES = ['DRAFT', 'DUE', 'OVERDUE', 'PAYMENT_FAILED', 'PAID', 'UNCOLLECTIBLE', 'VOID', 'UNKNOWN'] as const;
export type InvoicePaymentState = (typeof INVOICE_PAYMENT_STATES)[number];

export const PORTAL_CONFIGURATION_STATES = ['NOT_CONFIGURED', 'NOT_FOUND', 'INACTIVE', 'ACTIVE'] as const;
export type PortalConfigurationState = (typeof PORTAL_CONFIGURATION_STATES)[number];

export const BILLING_STATUS_DEFAULT_INVOICE_LIMIT = 12;
export const BILLING_STATUS_MAX_INVOICE_LIMIT = 50;

/**
 * The payment state of one invoice, from the provider's own status and dates only (mirror; no
 * arithmetic beyond "anything left to pay"). An open invoice with a failed collection attempt is
 * PAYMENT_FAILED. One past its due date is OVERDUE. Otherwise it is DUE.
 */
export function invoicePaymentState(inv: Pick<ProviderInvoiceState, 'provider_status' | 'amount_remaining_minor' | 'due_at' | 'attempt_count'>, now: Date): InvoicePaymentState {
  switch (inv.provider_status) {
    case 'draft':
      return 'DRAFT';
    case 'paid':
      return 'PAID';
    case 'uncollectible':
      return 'UNCOLLECTIBLE';
    case 'void':
      return 'VOID';
    case 'open':
      if (inv.amount_remaining_minor <= 0) return 'PAID';
      if (inv.due_at !== null && inv.due_at.getTime() < now.getTime()) return 'OVERDUE';
      if (inv.attempt_count > 0) return 'PAYMENT_FAILED';
      return 'DUE';
    default:
      return 'UNKNOWN';
  }
}

export interface BillingStatusInvoice extends ProviderInvoiceState {
  payment_state: InvoicePaymentState;
}

export interface TenantBillingStatus {
  tenant_id: string;
  product_key: ProductKey;
  availability: BillingStatusAvailability;
  provider: BillingProviderKey | null;
  mode: 'test' | 'live' | null;
  // The local Stripe-owned row the read went through (null when there is none).
  subscription: {
    id: string;
    source: string;
    status: string;
    open: boolean;
    account_ref: string;
    subscription_ref: string;
  } | null;
  // The provider's view (null unless availability is AVAILABLE).
  provider_subscription: {
    provider_status: string;
    current_period_start: Date;
    current_period_end: Date;
    cancel_at_period_end: boolean;
  } | null;
  invoices: BillingStatusInvoice[];
  detail: string | null;
  read_at: Date;
}

export interface BillingPortalConfigurationStatus {
  provider: BillingProviderKey;
  availability: Exclude<BillingStatusAvailability, 'NO_PROVIDER_SUBSCRIPTION' | 'TENANT_MISMATCH'>;
  mode: 'test' | 'live' | null;
  // STRIPE_PORTAL_CONFIGURATION as set (null when unset).
  configuration_ref: string | null;
  // null when it could not be read (availability other than AVAILABLE, with a ref set).
  configuration_state: PortalConfigurationState | null;
  configuration: Omit<ProviderPortalConfigurationState, 'provider' | 'configuration_ref'> | null;
  detail: string | null;
  read_at: Date;
}

export class BillingStatusQueryError extends Error {
  constructor(
    public readonly code: 'UNKNOWN_PRODUCT' | 'INVALID_LIMIT',
    message: string,
  ) {
    super(message);
    this.name = 'BillingStatusQueryError';
  }
}

@Injectable()
export class BillingStatusReadService {
  private readonly log = new Logger(BillingStatusReadService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_PROVIDER_READ_PORT) private readonly reader: BillingProviderReadPort,
  ) {}

  private gate(): { availability: 'BILLING_UNAVAILABLE' | 'LIVE_MODE_HELD'; mode: 'test' | 'live' | null; detail: string } | null {
    if (!this.reader.isConfigured()) return { availability: 'BILLING_UNAVAILABLE', mode: null, detail: 'the billing provider is not configured for this service' };
    if (this.reader.mode() === 'live') {
      return { availability: 'LIVE_MODE_HELD', mode: 'live', detail: 'provider reads run in test mode only until the live-billing release is authorized' };
    }
    return null;
  }

  async tenantBillingStatus(tenant_id: string, product_key: unknown, opts: { invoice_limit?: number; now?: Date } = {}): Promise<TenantBillingStatus> {
    let product: ProductKey;
    try {
      product = assertProductKey(product_key);
    } catch (err) {
      throw new BillingStatusQueryError('UNKNOWN_PRODUCT', (err as Error).message);
    }
    const limit = opts.invoice_limit ?? BILLING_STATUS_DEFAULT_INVOICE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > BILLING_STATUS_MAX_INVOICE_LIMIT) {
      throw new BillingStatusQueryError('INVALID_LIMIT', `invoice_limit must be an integer 1..${BILLING_STATUS_MAX_INVOICE_LIMIT}`);
    }
    const now = opts.now ?? new Date();
    const base: TenantBillingStatus = {
      tenant_id,
      product_key: product,
      availability: 'AVAILABLE',
      provider: null,
      mode: null,
      subscription: null,
      provider_subscription: null,
      invoices: [],
      detail: null,
      read_at: now,
    };

    const gated = this.gate();
    if (gated !== null) return { ...base, ...gated };
    base.provider = this.reader.provider;
    base.mode = 'test';

    // The tenant's Stripe-owned row for this product: the open one, else the most recent.
    const where = { tenant_id, product_key: product, source: 'SELF_SERVICE', billing_account_ref: { not: null }, billing_subscription_ref: { not: null } };
    const row =
      (await this.prisma.tenantSubscription.findFirst({ where: { ...where, ended_at: null }, orderBy: { started_at: 'desc' } })) ??
      (await this.prisma.tenantSubscription.findFirst({ where, orderBy: { started_at: 'desc' } }));
    if (row === null || row.billing_account_ref === null || row.billing_subscription_ref === null) {
      return { ...base, availability: 'NO_PROVIDER_SUBSCRIPTION', detail: 'no Stripe-owned subscription for this product (governed and contract subscriptions are not invoiced through the provider)' };
    }
    const subscription = {
      id: row.id,
      source: row.source,
      status: row.status,
      open: row.ended_at === null,
      account_ref: row.billing_account_ref,
      subscription_ref: row.billing_subscription_ref,
    };

    try {
      const ps = await this.reader.retrieveSubscription(subscription.subscription_ref);
      if (ps.tenant_id !== tenant_id || ps.account_ref !== subscription.account_ref || ps.subscription_ref !== subscription.subscription_ref) {
        this.log.warn(`CCP-C3 tenant mismatch on provider subscription ${subscription.subscription_ref} (tenant ${tenant_id})`);
        return { ...base, subscription, availability: 'TENANT_MISMATCH', detail: 'the provider subscription does not belong to this tenant and billing account' };
      }
      const invoices = await this.reader.listSubscriptionInvoices(subscription.subscription_ref, limit);
      if (invoices.some((i) => i.account_ref !== subscription.account_ref || i.subscription_ref !== subscription.subscription_ref)) {
        this.log.warn(`CCP-C3 tenant mismatch on an invoice of ${subscription.subscription_ref} (tenant ${tenant_id})`);
        return { ...base, subscription, availability: 'TENANT_MISMATCH', detail: 'a provider invoice does not belong to this tenant and billing account' };
      }
      return {
        ...base,
        subscription,
        provider_subscription: {
          provider_status: ps.provider_status,
          current_period_start: ps.current_period_start,
          current_period_end: ps.current_period_end,
          cancel_at_period_end: ps.cancel_at_period_end,
        },
        invoices: invoices.slice(0, limit).map((i) => ({ ...i, payment_state: invoicePaymentState(i, now) })),
      };
    } catch (err) {
      return { ...base, subscription, availability: 'PROVIDER_UNAVAILABLE', detail: (err as Error).message.slice(0, 300) };
    }
  }

  async portalConfigurationStatus(opts: { now?: Date } = {}): Promise<BillingPortalConfigurationStatus> {
    const now = opts.now ?? new Date();
    const configuration_ref = process.env['STRIPE_PORTAL_CONFIGURATION']?.trim() || null;
    const base: BillingPortalConfigurationStatus = {
      provider: this.reader.provider,
      availability: 'AVAILABLE',
      mode: null,
      configuration_ref,
      configuration_state: null,
      configuration: null,
      detail: null,
      read_at: now,
    };
    const gated = this.gate();
    if (gated !== null) return { ...base, ...gated, configuration_state: configuration_ref === null ? 'NOT_CONFIGURED' : null };
    base.mode = 'test';
    if (configuration_ref === null) {
      return { ...base, configuration_state: 'NOT_CONFIGURED', detail: 'STRIPE_PORTAL_CONFIGURATION is not set (commitment plans are refused the portal)' };
    }
    try {
      const c = await this.reader.retrievePortalConfiguration(configuration_ref);
      if (c === null) return { ...base, configuration_state: 'NOT_FOUND', detail: 'the provider has no portal configuration with this id' };
      const configuration = {
        active: c.active,
        is_default: c.is_default,
        live: c.live,
        invoice_history_enabled: c.invoice_history_enabled,
        payment_method_update_enabled: c.payment_method_update_enabled,
        subscription_cancel_enabled: c.subscription_cancel_enabled,
        subscription_cancel_mode: c.subscription_cancel_mode,
        subscription_update_enabled: c.subscription_update_enabled,
      };
      return { ...base, configuration_state: c.active ? 'ACTIVE' : 'INACTIVE', configuration };
    } catch (err) {
      return { ...base, availability: 'PROVIDER_UNAVAILABLE', detail: (err as Error).message.slice(0, 300) };
    }
  }
}
