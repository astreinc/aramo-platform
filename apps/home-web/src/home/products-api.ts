import { apiClient } from '@aramo/fe-foundation';

// D-ORG-1 (§3.D) — the backend-authoritative product availability read.
//   GET /v1/me/products → ProductAvailabilityView
// Hand-mirror of libs/identity ProductAvailabilityView (leaf consumer of the HTTP
// surface — the no-@aramo/* domain-import rule). The FE renders these booleans;
// it NEVER derives entitlement or authorization itself (no FE entitlement
// mirror, no auto role grant).
export const MY_PRODUCTS_PATH = '/v1/me/products';

export type ProductKey = 'ats' | 'esign' | 'org';
export type ProductUnavailableReason = 'not_subscribed' | 'not_authorized' | 'not_activated';

export interface ProductAvailability {
  readonly key: ProductKey;
  /** The tenant holds the product capability (subscription). */
  readonly subscribed: boolean;
  /** The caller holds a role/scope that can use the product. */
  readonly authorized: boolean;
  /** subscribed AND authorized AND activated — the tile is an entry. */
  readonly available: boolean;
  /** The in-host entry path when available (e.g. /ats/), else null. */
  readonly entry_path: string | null;
  readonly reason: ProductUnavailableReason | null;
}

export interface ProductAvailabilityView {
  readonly tenant_id: string;
  readonly products: readonly ProductAvailability[];
}

export function fetchMyProducts(): Promise<ProductAvailabilityView> {
  return apiClient.get<ProductAvailabilityView>(MY_PRODUCTS_PATH);
}

// The auth-service consumer that mints a product session. Entering a product
// from the App Home goes THROUGH that consumer's login (D-ORG-4: consumer-
// isolated sessions — the org session is never a product token) with the
// product's entry path as the sealed return_to (D-ORG-2).
const PRODUCT_CONSUMER: Record<Exclude<ProductKey, 'org'>, 'recruiter' | 'esign'> = {
  ats: 'recruiter',
  esign: 'esign',
};

export function productEntryHref(product: ProductAvailability): string | null {
  if (!product.available || product.entry_path === null) return null;
  if (product.key === 'org') return product.entry_path;
  return `/auth/${PRODUCT_CONSUMER[product.key]}/login?return_to=${encodeURIComponent(product.entry_path)}`;
}
