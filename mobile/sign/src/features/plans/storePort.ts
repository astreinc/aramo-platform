// M-A12 W1-G — the platform store behind one small port, so the purchase flow and the
// Plans screen are tested without a store (tests pass a fake). The production adapter
// (expoIapStore.ts) wraps `expo-iap`; nothing else in the app imports the library.
//
// A purchase is ours to finish only after the server accepted it (verify): the port never
// finishes or acknowledges on its own. Receipts, JWS and purchase tokens pass straight to
// the server and are never logged or stored.
import type { StorePlatform } from '../../api/m-a12-contract-types';

/** A store product as the store localizes it for this user. */
export interface StoreProductInfo {
  readonly productId: string;
  /** The store's localized price string, e.g. "$9.99" or "₹799.00". */
  readonly displayPrice: string;
  readonly currency: string | null;
  /** Android: the base-plan offer token the purchase must name. */
  readonly offerToken: string | null;
}

/** A completed (or restored) store transaction. */
export interface StorePurchase {
  readonly productId: string;
  /** iOS: the signed JWS transaction; Android: the purchase token. */
  readonly token: string;
  /** The library's own object, handed back to finish(); opaque to the app. */
  readonly handle: unknown;
}

export type StorePurchaseResult =
  | { readonly kind: 'purchased'; readonly purchase: StorePurchase }
  /** Ask to Buy / a pending payment method: the store confirms later. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly code: string };

export interface StorePort {
  readonly platform: StorePlatform;
  /** Open the store connection; false when the store is not available on this device. */
  connect(): Promise<boolean>;
  disconnect(): Promise<void>;
  /** Localized details for the subscription product ids (missing ids are left out). */
  products(productIds: readonly string[]): Promise<StoreProductInfo[]>;
  /**
   * Show the native purchase sheet. `accountToken` is the server's app_account_token:
   * iOS appAccountToken, Android obfuscatedAccountId.
   */
  purchase(product: StoreProductInfo, accountToken: string): Promise<StorePurchaseResult>;
  /** Finish (iOS) / complete (Android) a transaction the server has accepted. */
  finish(purchase: StorePurchase): Promise<void>;
  /** The user's current store subscriptions (Restore purchases). */
  restore(): Promise<StorePurchase[]>;
  /** Open the store's subscription management page. */
  manageSubscriptions(productId?: string): Promise<void>;
}

/** The current platform's store, or null where it can't be loaded (tests, web). */
export function defaultStorePort(): StorePort | null {
  try {
    // Lazy, so screens and tests that never buy never load the native module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('./expoIapStore') as typeof import('./expoIapStore');
    return mod.createExpoIapStore();
  } catch {
    return null;
  }
}
