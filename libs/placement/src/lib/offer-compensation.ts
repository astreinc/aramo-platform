// Offer compensation snapshot (L4-A / P1) — the structured, Talent-facing pay/
// salary terms PRESENTED to the talent. Pure validation (no I/O, no error
// framework — the repository maps a rejection to VALIDATION_ERROR 400), so it is
// fully unit-testable in isolation.
//
// This is deliberately NOT a commercial ledger: it carries ONLY the Talent-facing
// pay/salary terms. Bill rate, margin, markup, and internal target/min/max
// financial planning are Track-5 ContractAssignment concerns and NEVER appear here.
//
// compensation_type discriminates the shape: CONTRACT pays on a sub-annual cadence
// (HOURLY/DAILY/WEEKLY/MONTHLY); PERMANENT is an ANNUAL base salary. amount is a
// decimal string (money, never float — Decimal(12,2) at the DB); currency (ISO-4217)
// and period (rate-period) reuse the libs/common shared closed sets.
import { isIso4217Currency, isRatePeriod, type RatePeriod } from '@aramo/common';

export const OFFER_COMPENSATION_TYPES = ['CONTRACT', 'PERMANENT'] as const;
export type OfferCompensationType = (typeof OFFER_COMPENSATION_TYPES)[number];

const CONTRACT_PERIODS: readonly RatePeriod[] = ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'];
const PERMANENT_PERIOD: RatePeriod = 'ANNUAL';

export interface OfferCompensationSnapshot {
  readonly compensation_type: OfferCompensationType;
  readonly compensation_amount: string; // decimal string; Decimal(12,2) at the DB
  readonly compensation_currency: string; // ISO-4217
  readonly compensation_period: RatePeriod;
}

// The raw (possibly-absent, possibly-partial) comp input from the create surface.
export interface OfferCompensationInput {
  readonly compensation_type?: string | null;
  readonly compensation_amount?: string | number | null;
  readonly compensation_currency?: string | null;
  readonly compensation_period?: string | null;
}

export const OFFER_COMPENSATION_REJECTIONS = [
  'partial_snapshot', // some, but not all four, fields supplied — the snapshot is all-or-nothing
  'unknown_type',
  'invalid_amount',
  'unknown_currency',
  'unknown_period',
  'period_type_mismatch', // CONTRACT must be sub-annual; PERMANENT must be ANNUAL
] as const;
export type OfferCompensationRejection = (typeof OFFER_COMPENSATION_REJECTIONS)[number];

export type OfferCompensationClassification =
  | { readonly ok: true; readonly snapshot: OfferCompensationSnapshot | null }
  | { readonly ok: false; readonly reason: OfferCompensationRejection };

// A positive decimal with an integer part of at most 10 digits and at most 2
// fractional digits — the Decimal(12,2) envelope.
const AMOUNT_RE = /^\d{1,10}(\.\d{1,2})?$/;

// Classify a comp input. Absent (no field supplied) is OK → null snapshot (comp is
// optional at DRAFT create). If ANY field is supplied, ALL four are required and
// validated (all-or-nothing — never a half-specified money term).
export function classifyOfferCompensation(
  input: OfferCompensationInput,
): OfferCompensationClassification {
  const type = input.compensation_type ?? null;
  const amountRaw = input.compensation_amount ?? null;
  const currency = input.compensation_currency ?? null;
  const period = input.compensation_period ?? null;

  const present = [type, amountRaw, currency, period].filter((v) => v !== null && v !== '');
  if (present.length === 0) return { ok: true, snapshot: null };
  if (present.length < 4) return { ok: false, reason: 'partial_snapshot' };

  if (!(OFFER_COMPENSATION_TYPES as readonly string[]).includes(type as string)) {
    return { ok: false, reason: 'unknown_type' };
  }
  const amount = typeof amountRaw === 'number' ? amountRaw.toString() : String(amountRaw);
  if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
    return { ok: false, reason: 'invalid_amount' };
  }
  if (!isIso4217Currency(currency)) return { ok: false, reason: 'unknown_currency' };
  if (!isRatePeriod(period)) return { ok: false, reason: 'unknown_period' };

  const t = type as OfferCompensationType;
  const p = period as RatePeriod;
  if (t === 'PERMANENT' && p !== PERMANENT_PERIOD) return { ok: false, reason: 'period_type_mismatch' };
  if (t === 'CONTRACT' && !CONTRACT_PERIODS.includes(p)) return { ok: false, reason: 'period_type_mismatch' };

  return {
    ok: true,
    snapshot: {
      compensation_type: t,
      compensation_amount: amount,
      compensation_currency: currency,
      compensation_period: p,
    },
  };
}
