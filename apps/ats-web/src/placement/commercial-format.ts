// Track 6 / T6-B4 §28 — the small shared formatting/validation helper for the
// commercial-lifecycle UI. Keeps mask-aware value rendering and create-form validation
// in ONE place so every commercial component renders an omitted (masked) value
// identically and never leaks. Money/percent are decimal STRINGS the server returns
// verbatim (T5-P2) — the client never recomputes them.

// The non-leaking masked indicator (directive §7). A compensation field the actor's
// compensation:view:* scopes do not grant is OMITTED by the interceptor (absent key →
// `undefined` here); it is rendered as this em dash, never as `undefined`.
export const MASKED_INDICATOR = '—';

// A closed rate-period → display suffix map (bounded, feature-local — the deliberate
// duplication carried over from the T5-P3 panel; NOT extracted cross-feature).
const RATE_PERIOD_SUFFIX: Record<string, string> = {
  HOURLY: '/hr',
  DAILY: '/day',
  WEEKLY: '/wk',
  MONTHLY: '/mo',
  ANNUAL: '/yr',
};

export function periodSuffix(ratePeriod: string): string {
  return RATE_PERIOD_SUFFIX[ratePeriod] ?? '';
}

// Money render, mask-aware. `undefined` (omitted by the interceptor) → the masked
// indicator ALONE (never "— USD/hr", which would leak the field's structure). A present
// value renders verbatim with its currency + period suffix.
export function formatMoney(
  amount: string | undefined,
  currency: string,
  ratePeriod: string,
): string {
  if (amount === undefined) return MASKED_INDICATOR;
  return `${amount} ${currency}${periodSuffix(ratePeriod)}`;
}

// Percent render, mask-aware. `undefined` (masked/omitted) OR `null` (zero denominator)
// → the indicator; a present value renders with a % suffix. Both non-values collapse to
// the same indicator so a masked actor cannot distinguish "hidden" from "not computable".
export function formatPercent(value: string | null | undefined): string {
  return value === undefined || value === null ? MASKED_INDICATOR : `${value}%`;
}

// The client-side money shape guard — mirrors the BE Decimal(12,2) MONEY_12_2 (up to 10
// integer + up to 2 fractional digits). The server remains authoritative; this is a cheap
// pre-submit guard only (directive §11).
const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;

export function isValidMoney(value: string): boolean {
  return MONEY_12_2.test(value.trim());
}

// A currency wire guard — 3 uppercase letters (ISO-4217 shape). The BE validates against
// the active ISO-4217 set; this is a cheap pre-submit guard only.
const CURRENCY_SHAPE = /^[A-Z]{3}$/;

export function isValidCurrency(value: string): boolean {
  return CURRENCY_SHAPE.test(value.trim());
}
