import { useCallback, useEffect, useState } from 'react';

import { apiClient } from '../api/client';

// D-ORG-1 (§3.D) — the backend-authoritative product availability read. Moved from
// apps/home-web (unified multi-product shell) so App Home, Organization
// administration and the ATS app switcher all render the SAME backend answer.
//   GET /v1/me/products → ProductAvailabilityView
// Hand-mirror of libs/identity ProductAvailabilityView (leaf consumer of the HTTP
// surface — the no-@aramo/* domain-import rule). The FE renders these booleans;
// it NEVER derives entitlement or authorization itself (no FE entitlement
// mirror, no auto role grant).
export const MY_PRODUCTS_PATH = '/v1/me/products';

export type ProductKey = 'ats' | 'sign' | 'org';
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

// Shape guard: a malformed answer is treated as an error (fail closed — no
// product becomes enterable on a response the client cannot read).
function isAvailabilityView(v: unknown): v is ProductAvailabilityView {
  if (typeof v !== 'object' || v === null) return false;
  const products = (v as { products?: unknown }).products;
  return (
    Array.isArray(products) &&
    products.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as { key?: unknown }).key === 'string' &&
        typeof (p as { available?: unknown }).available === 'boolean',
    )
  );
}

export async function fetchMyProducts(): Promise<ProductAvailabilityView> {
  const v = await apiClient.get<unknown>(MY_PRODUCTS_PATH);
  if (!isAvailabilityView(v)) throw new Error('unexpected product availability response');
  return v;
}

// Opening a product goes to the product's own entry path. The product app then
// performs its OWN access check: no session for its consumer → that consumer's
// login (D-ORG-4 consumer-isolated sessions, `return_to` sealed server-side);
// a session without the product's scopes → the product's own refusal. The App
// Home / Organization session is never a product token, and a link is never
// authorization ("Each app checks your access again when it opens").
export function productEntryHref(product: ProductAvailability): string | null {
  if (!product.available || product.entry_path === null) return null;
  // A tenant-host path (/ats/, /org/) or an absolute http(s) URL for a product on
  // its own host (Sign: https://esign.aramo.ai/ — Lead Host & Workspace Ruling
  // v1.0). Anything else (javascript:, protocol-relative //host) is never a link.
  const p = product.entry_path;
  if (/^https?:\/\//i.test(p)) return p;
  if (p.startsWith('/') && !p.startsWith('//')) return p;
  return null;
}

export type ProductsState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: ProductAvailabilityView }
  | { readonly status: 'error' };

/** GET /v1/me/products once on mount, with a retry. Never throws. */
export function useMyProducts(fetchFn: () => Promise<ProductAvailabilityView> = fetchMyProducts): ProductsState & { readonly retry: () => void } {
  const [state, setState] = useState<ProductsState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchFn()
      .then((view) => {
        if (!cancelled) setState({ status: 'ready', view });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchFn, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, retry };
}

export function productByKey(view: ProductAvailabilityView | null, key: ProductKey): ProductAvailability | null {
  return Array.isArray(view?.products) ? (view.products.find((p) => p.key === key) ?? null) : null;
}
