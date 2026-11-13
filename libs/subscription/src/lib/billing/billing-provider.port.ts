// Aramo Sign launch — the billing-provider boundary. Stripe is authoritative for
// PAYMENT events; Aramo stays authoritative for the effective entitlement. The
// lifecycle service depends on this port only; the Stripe adapter implements it.

export const BILLING_PROVIDER_PORT = 'BILLING_PROVIDER_PORT';

import type { OrganizationBillingAddress } from './organization-billing-profile.port.js';

// M-A12 W1-G — the platform stores (Apple In-App Purchase, Google Play Billing) are billing
// providers too. Every Stripe-only port below (checkout, portal, commands, read, adjustments) keeps
// its `provider` = 'STRIPE' in practice; a store is reached only through the store ports
// (billing/store/store-billing.port.ts).
export type BillingProviderKey = 'STRIPE' | 'APP_STORE' | 'GOOGLE_PLAY' | 'RAZORPAY';

// India Billing Regions + Razorpay (directive v1.0 LOCKED §4.2) — the web (non-store) gateways. A web
// gateway's subscriptions are bought and managed on the web; a store's in the app.
export const WEB_BILLING_PROVIDERS = ['STRIPE', 'RAZORPAY'] as const;
export type WebBillingProviderKey = (typeof WEB_BILLING_PROVIDERS)[number];
export function isWebBillingProvider(p: string | null | undefined): p is WebBillingProviderKey { return p === 'STRIPE' || p === 'RAZORPAY'; }

export const STORE_BILLING_PROVIDERS = ['APP_STORE', 'GOOGLE_PLAY'] as const;
export type StoreBillingProviderKey = (typeof STORE_BILLING_PROVIDERS)[number];

export function isStoreBillingProvider(p: string | null | undefined): p is StoreBillingProviderKey {
  return p === 'APP_STORE' || p === 'GOOGLE_PLAY';
}

// A1 §2.6 — what Aramo writes onto the provider billing account (from the US
// organization profile). The provider's copy is the tax-relevant billing location
// and is re-verified on every sync (`ProviderSubscriptionState.account_country`).
export interface BillingAccountDetails {
  tenant_id: string;
  legal_name: string;
  billing_email: string;
  address: OrganizationBillingAddress;
}

export interface CheckoutSessionRequest {
  intent_id: string;
  tenant_id: string;
  user_id: string;
  user_email: string;
  price_ref: string;
  account_ref: string | null;
  success_url: string;
  cancel_url: string;
  // Sign Catalog v2 §4.3 (P-4) — a PERSONAL checkout: the billing address is collected (and
  // saved on the billing account) in the checkout, and the renewal disclosure is shown at submit.
  // Remaining-Work A1 — a Business checkout carries its renewal disclosure too (no address collection).
  collect_address?: boolean;
  disclosure?: string;
  // Sign Business per-seat pricing (directive v1.0 §3.3) — the line-item quantity (seats) of a per-seat
  // version; absent = 1 (every per-account checkout).
  quantity?: number;
}

// The provider's view of one subscription, as fetched from the provider (never
// trusted from a browser or from an unverified payload).
export interface ProviderSubscriptionState {
  provider: BillingProviderKey;
  subscription_ref: string;
  account_ref: string;
  // Raw provider status (e.g. Stripe: trialing | active | past_due | unpaid |
  // canceled | incomplete | incomplete_expired | paused).
  provider_status: string;
  current_period_start: Date;
  current_period_end: Date;
  cancel_at_period_end: boolean;
  price_ref: string | null;
  // Aramo identifiers stamped into provider metadata at checkout.
  tenant_id: string | null;
  intent_id: string | null;
  // A1 §2.6 — the billing account's country as the provider holds it now (ISO
  // alpha-2), or null when absent. Only 'US' may activate (fail closed).
  // M-A12 A1-3 — not applied to a store provider (the store is the merchant of record).
  account_country: string | null;
  // M-A12 W1-G — a store subscription only (absent for Stripe): the store product, the store
  // environment and the store's own grace end (billing retry with a grace period). The billed
  // interval (A1-1) is read from the product's pin, never from the store payload.
  store?: {
    product_id: string;
    environment: 'Sandbox' | 'Production' | null;
    grace_until: Date | null;
  };
  // Sign Business per-seat pricing (directive v1.0 §3.3) — the first subscription item and its quantity
  // (Stripe only; absent for a store). The quantity is the purchased seats of a per-seat version.
  item_ref?: string | null;
  quantity?: number | null;
}

export interface VerifiedBillingEvent {
  // M-A12 — the provider the event came from; absent = the bound BillingProviderPort's (Stripe).
  provider?: BillingProviderKey;
  id: string;
  type: string;
  created: Date;
  // The provider subscription the event concerns (resolved by the adapter from
  // the provider-specific payload), or null when the event carries none. The
  // lifecycle never trusts the payload's state: it re-fetches this subscription.
  subscription_ref: string | null;
  // CCP-C1 — the checkout session the event concerns (checkout.session.* events), or null /
  // absent. Used only to re-fetch the session (an expired session confirms an expire command).
  checkout_session_ref?: string | null;
  // CCP-C4 — the provider object the event concerns (its own id), or null / absent. Used only to
  // find a pending billing-adjustment command whose provider object it is; the effect is then
  // RE-FETCHED (the payload is never trusted).
  object_ref?: string | null;
}

export class BillingWebhookSignatureError extends Error {
  constructor(public readonly reason: 'MISSING' | 'MALFORMED' | 'STALE' | 'BAD_SIGNATURE' | 'NO_SECRET') {
    super(`billing webhook signature rejected: ${reason}`);
    this.name = 'BillingWebhookSignatureError';
  }
}

export class BillingProviderUnavailableError extends Error {
  // CCP-C1 — `retryable` false = the provider refused the request itself (a 4xx other than
  // 429): a retry with the same input cannot succeed. Network failures, 429 and 5xx are
  // transient (the default, so every existing caller keeps its behaviour).
  constructor(
    public readonly detail: string,
    public readonly retryable = true,
  ) {
    super(`billing provider unavailable: ${detail}`);
    this.name = 'BillingProviderUnavailableError';
  }
}

export interface BillingProviderPort {
  readonly provider: BillingProviderKey;
  isConfigured(): boolean;
  // A1 — 'live' only for live credentials (live charging is separately authorized).
  mode(): 'test' | 'live';
  /**
   * A1 §2.6 — create (account_ref null) or update the provider billing account
   * with the organization's legal name, billing email and registered address.
   * Returns the account_ref.
   */
  upsertBillingAccount(account_ref: string | null, details: BillingAccountDetails): Promise<string>;
  createCheckoutSession(req: CheckoutSessionRequest): Promise<{ session_ref: string; url: string }>;
  // `configuration` — a provider portal configuration (A1 review: commitment
  // plans use one whose cancellation terms match the approved contract).
  createPortalSession(account_ref: string, return_url: string, configuration?: string): Promise<{ url: string }>;
  retrieveSubscription(subscription_ref: string): Promise<ProviderSubscriptionState>;
  // India Billing (§4.7) — `context.event_id`: the provider's delivery event id when it is sent as a
  // header (Razorpay); a provider whose payload carries its id ignores it (Stripe).
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSec: number, context?: { event_id?: string | undefined }): VerifiedBillingEvent;
}

// ---------------------------------------------------------------------------------------
// CCP-C1 (PBD §5.2 row C1; Conversion Rule C-22) — the Stripe-owned operations Aramo issues as
// durable commands. A separate port (bound to the same Stripe adapter) so the existing
// BillingProviderPort implementations are unchanged. Every call runs OUTSIDE any local DB
// transaction (BillingCommandService); each write carries the command's idempotency key.
// ---------------------------------------------------------------------------------------

export const BILLING_PROVIDER_COMMAND_PORT = 'BILLING_PROVIDER_COMMAND_PORT';

/** The provider's view of one checkout session, as fetched from the provider. */
export interface ProviderCheckoutSessionState {
  provider: BillingProviderKey;
  session_ref: string;
  // Raw provider status (Stripe: open | complete | expired).
  status: string;
  // Aramo identifiers stamped into the session metadata at checkout.
  tenant_id: string | null;
  intent_id: string | null;
}

export interface BillingProviderCommandPort {
  readonly provider: BillingProviderKey;
  isConfigured(): boolean;
  mode(): 'test' | 'live';
  /** Cancel a provider subscription, now or at the end of the current period. */
  cancelSubscription(subscription_ref: string, opts: { at_period_end: boolean }, idempotency_key: string): Promise<void>;
  /** Expire an open checkout session (it can no longer be completed). */
  expireCheckoutSession(session_ref: string, idempotency_key: string): Promise<void>;
  retrieveCheckoutSession(session_ref: string): Promise<ProviderCheckoutSessionState>;
}

// ---------------------------------------------------------------------------------------
// CCP-C3 (PBD §5.2 row C3; Charter §3 "Aramo SHALL mirror status only"; L5) — the READ-ONLY
// provider port for invoice and payment status and the portal configuration. A separate port
// bound to a separate adapter class (StripeBillingReadAdapter) that has no mutating method and
// issues GET only, so no write to the provider is reachable through it. The existing
// BillingProviderPort / BillingProviderCommandPort and their fakes are unchanged.
// ---------------------------------------------------------------------------------------

export const BILLING_PROVIDER_READ_PORT = 'BILLING_PROVIDER_READ_PORT';

/** The provider's view of one invoice (a status mirror; amounts in the currency's minor unit). */
export interface ProviderInvoiceState {
  provider: BillingProviderKey;
  invoice_ref: string;
  number: string | null;
  account_ref: string;
  subscription_ref: string | null;
  // Raw provider status (Stripe: draft | open | paid | uncollectible | void).
  provider_status: string;
  currency: string | null;
  total_minor: number;
  amount_due_minor: number;
  amount_paid_minor: number;
  amount_remaining_minor: number;
  created_at: Date | null;
  due_at: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  // The provider-hosted invoice page and document (link-outs; Aramo renders no invoice).
  hosted_url: string | null;
  document_url: string | null;
  live: boolean;
}

/** The provider's view of one billing-portal configuration. */
export interface ProviderPortalConfigurationState {
  provider: BillingProviderKey;
  configuration_ref: string;
  active: boolean;
  is_default: boolean;
  live: boolean;
  invoice_history_enabled: boolean;
  payment_method_update_enabled: boolean;
  subscription_cancel_enabled: boolean;
  // Stripe: at_period_end | immediately (null when absent).
  subscription_cancel_mode: string | null;
  subscription_update_enabled: boolean;
}

/** READ-ONLY. Every method is a provider read; none changes provider state. */
export interface BillingProviderReadPort {
  readonly provider: BillingProviderKey;
  isConfigured(): boolean;
  mode(): 'test' | 'live';
  retrieveSubscription(subscription_ref: string): Promise<ProviderSubscriptionState>;
  /** The subscription's invoices, newest first, at most `limit`. */
  listSubscriptionInvoices(subscription_ref: string, limit: number): Promise<ProviderInvoiceState[]>;
  /** The configuration, or null when the provider has no such configuration. */
  retrievePortalConfiguration(configuration_ref: string): Promise<ProviderPortalConfigurationState | null>;
}

// ---------------------------------------------------------------------------------------
// CCP-C4 (PBD §5.2 row C4; Conversion Rule C-22, C-23) — the Stripe-side billing adjustments
// (credits, discounts, refunds), executed ONLY as C1 durable commands. A separate port (bound to
// the same Stripe adapter) so every existing port and fake is unchanged. Every call runs OUTSIDE
// any local DB transaction (BillingCommandService); every write carries the command's derived
// idempotency key and the command id as provider metadata.
// ---------------------------------------------------------------------------------------

export const BILLING_PROVIDER_ADJUSTMENT_PORT = 'BILLING_PROVIDER_ADJUSTMENT_PORT';

export type ProviderAdjustmentOperation = 'CREDIT_GRANT' | 'CREDIT_REVERSE' | 'DISCOUNT_APPLY' | 'DISCOUNT_REMOVE' | 'REFUND_CREATE';

/** One adjustment as the command describes it (never a free-form provider call). */
export interface ProviderAdjustmentRequest {
  operation: ProviderAdjustmentOperation;
  /** The Aramo command id, stamped as provider metadata (the re-read finds the effect by it). */
  command_id: string;
  tenant_id: string;
  /** CREDIT_*: the provider account; DISCOUNT_*: the provider subscription; REFUND_CREATE: the provider invoice. */
  target_ref: string;
  /** REFUND_CREATE: the provider account that paid the invoice (the re-read verifies it). */
  account_ref?: string;
  /** CREDIT_* / REFUND_CREATE: the amount in the currency's minor unit (always positive). */
  amount_minor?: number;
  currency?: string;
  /** DISCOUNT_APPLY: the percentage in basis points. */
  discount_bps?: number;
  /** DISCOUNT_*: the deterministic provider coupon id of the discount. */
  coupon_ref?: string;
}

/** The provider's view of one adjustment's effect, as re-read from the provider. */
export interface ProviderAdjustmentEffect {
  provider: BillingProviderKey;
  operation: ProviderAdjustmentOperation;
  /** The provider object carrying the effect (balance transaction, discount, refund), when one exists. */
  object_ref: string | null;
  /** True when the provider shows the operation's effect in place. */
  present: boolean;
  /** Raw provider status of the object (e.g. a refund: pending | succeeded | failed), or null. */
  provider_status: string | null;
  /** The Aramo tenant stamped on the object (metadata), when present: a mismatch is refused. */
  tenant_id: string | null;
  live: boolean;
  /**
   * CCP-C4-R (REFUND only) — the amount of the refund found for this command (null when none), the
   * payment's remaining refundable amount (paid − refunds succeeded or pending; null when unknown)
   * and the payment's currency. Used to refuse an over-refund before any write and to tell a
   * confirmed refund from a partial / mismatched one.
   */
  observed_amount_minor?: number | null;
  refundable_remainder_minor?: number | null;
  payment_currency?: string | null;
}

/**
 * CCP-C4-P (Amendment A1 RF-4, RF-5) — the provider's authoritative picture of ONE paid invoice's
 * payment: who paid, the payment, its currency and captured amount, every refund of that payment
 * and every dispute (chargeback) on it. `complete` is false when a list was truncated (the picture
 * cannot then be reconciled confidently).
 */
export interface ProviderPaymentPicture {
  provider: BillingProviderKey;
  invoice_ref: string;
  account_ref: string;
  payment_ref: string | null;
  currency: string | null;
  captured_minor: number;
  refunds: Array<{ object_ref: string | null; amount_minor: number; status: string | null; command_id: string | null }>;
  disputes: Array<{ object_ref: string | null; amount_minor: number; status: string | null }>;
  complete: boolean;
  live: boolean;
}

export interface BillingProviderAdjustmentPort {
  readonly provider: BillingProviderKey;
  isConfigured(): boolean;
  mode(): 'test' | 'live';
  /** Execute the adjustment at the provider (idempotent by key). Returns the provider object ref. */
  executeAdjustment(req: ProviderAdjustmentRequest, idempotency_key: string): Promise<{ object_ref: string }>;
  /**
   * Re-read the provider: the effect of `req` (by `object_ref` when known, otherwise by the command
   * id in the provider metadata). Never changes provider state.
   */
  readAdjustmentEffect(req: ProviderAdjustmentRequest, object_ref: string | null): Promise<ProviderAdjustmentEffect>;
  /** CCP-C4-P — read the payment picture of one invoice (READ ONLY; never changes provider state). */
  readPaymentPicture(invoice_ref: string): Promise<ProviderPaymentPicture>;
}

// ---------------------------------------------------------------------------------------
// Sign Business per-seat pricing (Implementation Directive v1.0 LOCKED §3.3) — the seat quantity of a
// provider subscription. A separate port (bound to the same Stripe adapter) so every existing port and
// fake is unchanged. Called OUTSIDE any local DB transaction, with an idempotency key.
// ---------------------------------------------------------------------------------------

export const BILLING_PROVIDER_SEAT_PORT = 'BILLING_PROVIDER_SEAT_PORT';

/**
 * `create_prorations` — an increase, prorated now (O-2, the provider's default). `none` — no proration:
 * a decrease billed from the next period (no refund, O-2), or restoring the paid quantity.
 */
export type SeatProrationBehavior = 'create_prorations' | 'none';

export interface BillingProviderSeatPort {
  readonly provider: BillingProviderKey;
  isConfigured(): boolean;
  /** Set the quantity of the subscription's (single) item. Returns the provider's state after the change. */
  updateSubscriptionQuantity(subscription_ref: string, quantity: number, proration: SeatProrationBehavior, idempotency_key: string): Promise<ProviderSubscriptionState>;
}
