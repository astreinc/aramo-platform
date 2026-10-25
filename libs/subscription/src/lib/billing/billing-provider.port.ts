// Aramo Sign launch — the billing-provider boundary. Stripe is authoritative for
// PAYMENT events; Aramo stays authoritative for the effective entitlement. The
// lifecycle service depends on this port only; the Stripe adapter implements it.

export const BILLING_PROVIDER_PORT = 'BILLING_PROVIDER_PORT';

import type { OrganizationBillingAddress } from './organization-billing-profile.port.js';

export type BillingProviderKey = 'STRIPE';

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
  account_country: string | null;
}

export interface VerifiedBillingEvent {
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
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSec: number): VerifiedBillingEvent;
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
