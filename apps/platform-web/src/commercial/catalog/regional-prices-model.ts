import type { CatalogRegionalPrice } from './catalog-api';

// Sign Mobile M-A12 Amendment A1-3 — the regional price editor's pure model. A regional price is a
// list price for one country and interval in that country's currency (e.g. IN / INR, monthly). It is
// part of the plan version's terms: edited on a DRAFT only, approved Finance → Owner with the rest of
// the version, immutable once published. The store always charges its own localized price; the
// reconciliation report flags a store price that differs.

/** Minor-unit exponent of the zero / three-decimal currencies; every other currency is 2. */
const EXPONENT: Readonly<Record<string, number>> = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };

export function currencyExponent(currency: string): number {
  return EXPONENT[currency.toUpperCase()] ?? 2;
}

/** "899.00 INR / month". */
export function formatRegionalPrice(p: CatalogRegionalPrice): string {
  const exp = currencyExponent(p.currency);
  const amount = (p.amount_minor / 10 ** exp).toFixed(exp);
  return `${amount} ${p.currency} / ${p.interval === 'YEAR' ? 'year' : 'month'}`;
}

export type RegionalPriceInput = { country: string; currency: string; interval: 'MONTH' | 'YEAR'; amount: string };

export type RegionalPriceParse =
  | { ok: true; edit: { country: string; currency: string; interval: 'MONTH' | 'YEAR'; amount_minor: number } }
  | { ok: false; error: string };

/** Validates the add form (fails closed with a message the console shows). */
export function parseRegionalPriceInput(i: RegionalPriceInput): RegionalPriceParse {
  const country = i.country.trim().toUpperCase();
  const currency = i.currency.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, error: 'Enter a two-letter country code (for example IN).' };
  if (country === 'US') return { ok: false, error: 'The US price is the plan’s list price. Edit it above.' };
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'Enter a three-letter currency code (for example INR).' };
  const exp = currencyExponent(currency);
  const raw = i.amount.trim();
  const re = exp === 0 ? /^\d{1,10}$/ : new RegExp(`^\\d{1,10}(\\.\\d{1,${exp}})?$`);
  if (!re.test(raw)) return { ok: false, error: `Enter the price in ${currency}${exp === 0 ? ' (whole units)' : ` (up to ${exp} decimals)`}.` };
  const amount_minor = Math.round(Number(raw) * 10 ** exp);
  if (!Number.isSafeInteger(amount_minor) || amount_minor > 1_000_000_000) return { ok: false, error: 'That price is too large.' };
  return { ok: true, edit: { country, currency, interval: i.interval, amount_minor } };
}

/** The version's regional prices, sorted by country then interval (MONTH first). */
export function regionalRows(prices: readonly CatalogRegionalPrice[] | undefined): CatalogRegionalPrice[] {
  return [...(prices ?? [])].sort((a, b) => (a.country === b.country ? (a.interval === b.interval ? 0 : a.interval === 'MONTH' ? -1 : 1) : a.country < b.country ? -1 : 1));
}
