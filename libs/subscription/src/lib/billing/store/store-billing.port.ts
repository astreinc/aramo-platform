import type { ProviderSubscriptionState, StoreBillingProviderKey } from '../billing-provider.port.js';

// Aramo Sign Mobile M-A12 W1-G — the store boundary. The lifecycle re-fetches a store subscription
// through STORE_SUBSCRIPTION_READER (never trusting a payload), exactly as it re-fetches Stripe
// through BillingProviderPort. Unbound (no store adapters): a store event is IGNORED.

export const STORE_SUBSCRIPTION_READER = 'STORE_SUBSCRIPTION_READER';
export const APPLE_APP_STORE_PORT = 'APPLE_APP_STORE_PORT';
export const GOOGLE_PLAY_PORT = 'GOOGLE_PLAY_PORT';

export interface StoreSubscriptionPort {
  readonly provider: StoreBillingProviderKey;
  isConfigured(): boolean;
  /** The store's authoritative state of one subscription (Apple: originalTransactionId; Play: purchase token). */
  retrieveSubscription(ref: string): Promise<ProviderSubscriptionState>;
}

export interface StoreSubscriptionReader {
  isConfigured(provider: StoreBillingProviderKey): boolean;
  retrieve(provider: StoreBillingProviderKey, ref: string): Promise<ProviderSubscriptionState>;
}

/** A store purchase or notification that failed verification (a reason code, never the payload). */
export class StoreVerificationError extends Error {
  constructor(public readonly reason: string) {
    super(`store verification failed: ${reason}`);
    this.name = 'StoreVerificationError';
  }
}

export type StoreFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The registry over the configured store adapters. */
export class StoreSubscriptionRegistry implements StoreSubscriptionReader {
  private readonly ports: Map<StoreBillingProviderKey, StoreSubscriptionPort>;

  constructor(ports: readonly StoreSubscriptionPort[]) {
    this.ports = new Map(ports.map((p) => [p.provider, p]));
  }

  isConfigured(provider: StoreBillingProviderKey): boolean {
    return this.ports.get(provider)?.isConfigured() === true;
  }

  async retrieve(provider: StoreBillingProviderKey, ref: string): Promise<ProviderSubscriptionState> {
    const p = this.ports.get(provider);
    if (p === undefined || !p.isConfigured()) throw new StoreVerificationError('store_not_configured');
    return p.retrieveSubscription(ref);
  }
}
