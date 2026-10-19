// Aramo Sign launch — the billing-provider boundary. Stripe is authoritative for
// PAYMENT events; Aramo stays authoritative for the effective entitlement. The
// lifecycle service depends on this port only; the Stripe adapter implements it.

export const BILLING_PROVIDER_PORT = 'BILLING_PROVIDER_PORT';

export type BillingProviderKey = 'STRIPE';

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
}

export interface VerifiedBillingEvent {
  id: string;
  type: string;
  created: Date;
  // The provider subscription the event concerns (resolved by the adapter from
  // the provider-specific payload), or null when the event carries none. The
  // lifecycle never trusts the payload's state: it re-fetches this subscription.
  subscription_ref: string | null;
}

export class BillingWebhookSignatureError extends Error {
  constructor(public readonly reason: 'MISSING' | 'MALFORMED' | 'STALE' | 'BAD_SIGNATURE' | 'NO_SECRET') {
    super(`billing webhook signature rejected: ${reason}`);
    this.name = 'BillingWebhookSignatureError';
  }
}

export class BillingProviderUnavailableError extends Error {
  constructor(public readonly detail: string) {
    super(`billing provider unavailable: ${detail}`);
    this.name = 'BillingProviderUnavailableError';
  }
}

export interface BillingProviderPort {
  readonly provider: BillingProviderKey;
  isConfigured(): boolean;
  // A1 — 'live' only for live credentials (live charging is separately authorized).
  mode(): 'test' | 'live';
  createCheckoutSession(req: CheckoutSessionRequest): Promise<{ session_ref: string; url: string }>;
  createPortalSession(account_ref: string, return_url: string): Promise<{ url: string }>;
  retrieveSubscription(subscription_ref: string): Promise<ProviderSubscriptionState>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSec: number): VerifiedBillingEvent;
}
