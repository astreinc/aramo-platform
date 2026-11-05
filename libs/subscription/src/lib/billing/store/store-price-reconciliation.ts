import type { StoreBillingProviderKey } from '../billing-provider.port.js';

// Aramo Sign Mobile M-A12 Amendment A1-3 (LOCKED) — the reconciliation check: a report entry for any
// store product whose store price differs from the published regional price for that country. The
// app always charges and shows the store's localized price; nothing is blocked at runtime. Pure.
//
//   MATCH                    the store price equals the published regional price (same currency)
//   MISMATCH                 a different amount or currency for the country
//   NO_REGIONAL_PRICE        the store sells in the country, the version publishes no regional price
//   NOT_IN_STORE             a published regional price for a country the store product is not sold in
//   STORE_PRICE_UNAVAILABLE  the store's prices could not be read (not configured, unreachable, or Apple)

export type StorePriceReconciliationStatus = 'MATCH' | 'MISMATCH' | 'NO_REGIONAL_PRICE' | 'NOT_IN_STORE' | 'STORE_PRICE_UNAVAILABLE';

export interface StorePriceReconciliationEntry {
  plan_key: string;
  plan_version_id: string;
  provider: StoreBillingProviderKey;
  product_id: string;
  interval: 'MONTH' | 'YEAR';
  country: string | null;
  status: StorePriceReconciliationStatus;
  published: { currency: string; amount_minor: number } | null;
  store: { currency: string; amount_minor: number } | null;
}

export interface StorePinTerms {
  plan_key: string;
  plan_version_id: string;
  provider: StoreBillingProviderKey;
  product_id: string;
  interval: 'MONTH' | 'YEAR';
  regional_prices: readonly { country: string; currency: string; amount_minor: number; interval: 'MONTH' | 'YEAR' }[];
}

export function reconcileStorePrices(
  pins: readonly StorePinTerms[],
  storePrices: (provider: StoreBillingProviderKey, product_id: string) => readonly { country: string; currency: string; amount_minor: number }[] | null,
): StorePriceReconciliationEntry[] {
  const out: StorePriceReconciliationEntry[] = [];
  for (const pin of pins) {
    const base = { plan_key: pin.plan_key, plan_version_id: pin.plan_version_id, provider: pin.provider, product_id: pin.product_id, interval: pin.interval };
    const published = new Map(pin.regional_prices.filter((r) => r.interval === pin.interval).map((r) => [r.country, { currency: r.currency, amount_minor: r.amount_minor }]));
    const observed = storePrices(pin.provider, pin.product_id);
    if (observed === null) {
      out.push({ ...base, country: null, status: 'STORE_PRICE_UNAVAILABLE', published: null, store: null });
      continue;
    }
    const store = new Map(observed.map((o) => [o.country.toUpperCase(), { currency: o.currency.toUpperCase(), amount_minor: o.amount_minor }]));
    for (const country of [...new Set([...published.keys(), ...store.keys()])].sort()) {
      // The US price is the plan's list price, not a regional price: not reconciled here.
      if (country === 'US') continue;
      const p = published.get(country) ?? null;
      const s = store.get(country) ?? null;
      const status: StorePriceReconciliationStatus =
        p === null ? 'NO_REGIONAL_PRICE' : s === null ? 'NOT_IN_STORE' : p.currency === s.currency && p.amount_minor === s.amount_minor ? 'MATCH' : 'MISMATCH';
      // The report lists the exceptions and the matches of a published regional price; an unpriced
      // store country is listed only when the version publishes regional prices at all.
      if (status === 'NO_REGIONAL_PRICE' && published.size === 0) continue;
      out.push({ ...base, country, status, published: p, store: s });
    }
  }
  return out;
}
