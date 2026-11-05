import type { ProviderSubscriptionState } from '../billing-provider.port.js';

import type { AppleRenewalInfoPayload, AppleTransactionPayload } from './apple-jws.verifier.js';
import { StoreVerificationError } from './store-billing.port.js';

// Aramo Sign Mobile M-A12 W1-G item 4 (LOCKED) — the store states mapped onto the EXISTING status
// machine (mapProviderStatus in subscription-lifecycle.service.ts), expressed in its provider
// vocabulary so no second machine exists:
//
//   store state                                         provider_status  Aramo
//   active (auto-renew on or off)                       active           ACTIVE (auto-renew off: cancel_at_period_end)
//   in grace (Apple status 4 / Play IN_GRACE_PERIOD)    past_due         PAST_DUE, grace_until = the store's grace end
//   billing retry (Apple status 3)                      past_due         PAST_DUE, grace_until = Aramo's grace window
//   on hold (Play ON_HOLD) / paused (Play PAUSED)       unpaid / paused  PAST_DUE, not sending
//   expired (Apple 2 / Play EXPIRED)                    canceled         CANCELED, ended (Personal falls back to Free)
//   refunded / revoked (Apple 5 or revocationDate)      canceled         CANCELED, ended immediately
//   pending (Play PENDING)                              incomplete       INCOMPLETE
//   pending purchase canceled                           incomplete_expired  ended
// The interval (A1-1) comes from the pinned product, never from the payload.

/** Apple subscription status (App Store Server API) → the provider state. */
export function appleSubscriptionState(status: number, tx: AppleTransactionPayload, renewal: AppleRenewalInfoPayload | null): ProviderSubscriptionState {
  if (typeof tx.originalTransactionId !== 'string' || typeof tx.productId !== 'string' || typeof tx.expiresDate !== 'number') throw new StoreVerificationError('malformed');
  const revoked = typeof tx.revocationDate === 'number';
  const store_grace = typeof renewal?.gracePeriodExpiresDate === 'number' ? new Date(renewal.gracePeriodExpiresDate) : null;
  let provider_status: string;
  if (revoked || status === 5) provider_status = 'canceled';
  else if (status === 1) provider_status = 'active';
  else if (status === 2) provider_status = 'canceled';
  else if (status === 3 || status === 4) provider_status = 'past_due';
  else provider_status = 'incomplete';
  return {
    provider: 'APP_STORE',
    subscription_ref: tx.originalTransactionId,
    account_ref: '',
    provider_status,
    current_period_start: new Date(typeof tx.purchaseDate === 'number' ? tx.purchaseDate : 0),
    current_period_end: new Date(tx.expiresDate),
    cancel_at_period_end: renewal !== null && renewal.autoRenewStatus === 0,
    price_ref: tx.productId,
    tenant_id: null,
    intent_id: typeof tx.appAccountToken === 'string' ? tx.appAccountToken.toLowerCase() : null,
    account_country: null,
    store: {
      product_id: tx.productId,
      environment: tx.environment === 'Sandbox' || tx.environment === 'Production' ? tx.environment : null,
      grace_until: status === 4 ? store_grace : null,
    },
  };
}

/** The subset of Android Publisher subscriptionsv2 Aramo reads. */
export interface PlaySubscriptionPurchaseV2 {
  subscriptionState?: string;
  startTime?: string;
  testPurchase?: unknown;
  acknowledgementState?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  lineItems?: { productId?: string; expiryTime?: string; autoRenewingPlan?: { autoRenewEnabled?: boolean } }[];
}

const PLAY_STATUS: Record<string, string> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active',
  SUBSCRIPTION_STATE_CANCELED: 'active',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'past_due',
  SUBSCRIPTION_STATE_ON_HOLD: 'unpaid',
  SUBSCRIPTION_STATE_PAUSED: 'paused',
  SUBSCRIPTION_STATE_EXPIRED: 'canceled',
  SUBSCRIPTION_STATE_PENDING: 'incomplete',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'incomplete_expired',
};

/** Play subscriptionsv2 → the provider state. */
export function playSubscriptionState(purchase_token: string, p: PlaySubscriptionPurchaseV2): ProviderSubscriptionState {
  const line = p.lineItems?.[0];
  const expiry = line?.expiryTime !== undefined ? new Date(line.expiryTime) : null;
  if (line === undefined || typeof line.productId !== 'string' || expiry === null || !Number.isFinite(expiry.getTime())) throw new StoreVerificationError('malformed');
  const state = p.subscriptionState ?? '';
  const provider_status = PLAY_STATUS[state] ?? 'incomplete';
  const start = p.startTime !== undefined ? new Date(p.startTime) : new Date(0);
  return {
    provider: 'GOOGLE_PLAY',
    subscription_ref: purchase_token,
    account_ref: '',
    provider_status,
    current_period_start: Number.isFinite(start.getTime()) ? start : new Date(0),
    current_period_end: expiry,
    cancel_at_period_end: state === 'SUBSCRIPTION_STATE_CANCELED' || line.autoRenewingPlan?.autoRenewEnabled === false,
    price_ref: line.productId,
    tenant_id: null,
    intent_id: typeof p.externalAccountIdentifiers?.obfuscatedExternalAccountId === 'string' ? p.externalAccountIdentifiers.obfuscatedExternalAccountId.toLowerCase() : null,
    account_country: null,
    store: {
      product_id: line.productId,
      environment: p.testPurchase !== undefined ? 'Sandbox' : 'Production',
      // In the Play grace period the line item's expiryTime is the end of the grace period.
      grace_until: state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ? expiry : null,
    },
  };
}
