// Track 7 / T7-P1 — governed guarantee-terms validation + snapshot derivation
// (directive §5 / §9, T7-PRE §5/§7/§9). PURE: no I/O, no DB. Consumed by the
// PERMANENT STARTED branch to produce the immutable activation snapshot, or to
// fail closed BEFORE any mutation. The guarantee is a CALENDAR concept — dates,
// not wall-clock instants; the window is half-open [start, start + duration).
//
// Fail-closed error mapping (directive §10):
//   - absent terms / missing-or-ambiguous term  -> PERMANENT_PLACEMENT_TERMS_REQUIRED (422)
//   - bad date / non-positive duration / bad end -> PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID (422)
//   - bad exposure amount / currency             -> PERMANENT_PLACEMENT_EXPOSURE_INVALID (422)

import { AramoError, isIso4217Currency } from '@aramo/common';

import { REMEDY_POLICIES, type RemedyPolicy } from '../lifecycle/placement-lifecycle.js';
import type { GuaranteeTermsInput } from '../placement-process.types.js';

// Decimal money string (never a float): up to 10 integer digits and up to 2
// fractional, matching the Decimal(12,2) exposure column — the T5 MONEY_12_2
// precedent. Defensive at the repository boundary (the HTTP DTO also validates).
const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;

// Calendar date, strict yyyy-mm-dd.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type ValidatedGuaranteeSnapshot = {
  readonly guarantee_start_date: Date;
  readonly guarantee_duration_days: number;
  readonly guarantee_end_date: Date;
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string;
  readonly guarantee_exposure_currency: string;
  readonly terms_source: string;
  readonly recorded_by: string;
};

// Parse a strict yyyy-mm-dd into a UTC-midnight Date, or null if malformed /
// non-round-tripping (e.g. 2026-02-30). Timezone-stable: the guarantee is a
// calendar fact, so all arithmetic is in UTC.
export function parseCalendarDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  // Reject non-round-tripping dates (JS rolls 2026-02-30 forward).
  if (d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

// Add whole calendar days in UTC — the half-open window end.
function addUtcDays(start: Date, days: number): Date {
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + days);
  return end;
}

function windowInvalid(requestId: string, reason: string, extra: Record<string, unknown> = {}): AramoError {
  return new AramoError(
    'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID',
    'the guarantee window is invalid',
    422,
    { requestId, details: { reason, ...extra } },
  );
}

// Validate the governed guarantee terms and derive the immutable snapshot, or
// throw a fail-closed AramoError. recorded_by is the acting principal (JWT sub),
// threaded from the transition input.
export function validateGuaranteeTerms(
  terms: GuaranteeTermsInput | null | undefined,
  recorded_by: string | null | undefined,
  requestId: string,
): ValidatedGuaranteeSnapshot {
  if (terms == null) {
    throw new AramoError(
      'PERMANENT_PLACEMENT_TERMS_REQUIRED',
      'starting a permanent placement requires the governed guarantee terms (guarantee_start_date, guarantee_duration_days, remedy_policy, exposure_amount, exposure_currency, terms_source)',
      422,
      { requestId, details: { reason: 'guarantee_terms_required' } },
    );
  }

  // recorded_by — the recording provenance (§7). Required, no hidden default.
  if (!recorded_by) {
    throw new AramoError('VALIDATION_ERROR', 'a recording principal (recorded_by) is required for guarantee terms', 400, {
      requestId,
      details: { field: 'recorded_by' },
    });
  }

  // terms_source provenance (§7 — no hidden default).
  if (typeof terms.terms_source !== 'string' || terms.terms_source.trim().length === 0) {
    throw new AramoError('PERMANENT_PLACEMENT_TERMS_REQUIRED', 'guarantee terms_source (provenance) is required', 422, {
      requestId,
      details: { reason: 'terms_source_required' },
    });
  }

  // remedy_policy — exactly one governed policy (§8: never heuristic among several).
  if (!(REMEDY_POLICIES as readonly string[]).includes(terms.remedy_policy)) {
    throw new AramoError('PERMANENT_PLACEMENT_TERMS_REQUIRED', 'guarantee remedy_policy must be exactly one of REPLACEMENT, REFUND, PRORATED_CREDIT', 422, {
      requestId,
      details: { reason: 'remedy_policy_invalid', remedy_policy: terms.remedy_policy },
    });
  }

  // guarantee_start_date — a valid calendar date (the actual permanent start).
  const start = parseCalendarDate(terms.guarantee_start_date);
  if (start === null) {
    throw windowInvalid(requestId, 'start_date_invalid', { guarantee_start_date: terms.guarantee_start_date });
  }

  // guarantee_duration_days — a positive integer (else fail closed before activation).
  const duration = terms.guarantee_duration_days;
  if (!Number.isInteger(duration) || duration <= 0) {
    throw windowInvalid(requestId, 'duration_not_positive_integer', { guarantee_duration_days: duration });
  }

  const end = addUtcDays(start, duration);
  // Half-open window integrity — end strictly after start (a positive duration
  // guarantees it; asserted so an impossible ordering can never activate).
  if (!(end.getTime() > start.getTime())) {
    throw windowInvalid(requestId, 'end_not_after_start');
  }

  // exposure — a governed decimal money amount + an active ISO-4217 currency.
  if (typeof terms.exposure_amount !== 'string' || !MONEY_12_2.test(terms.exposure_amount)) {
    throw new AramoError('PERMANENT_PLACEMENT_EXPOSURE_INVALID', 'guarantee exposure_amount must be a non-negative Decimal(12,2) money string', 422, {
      requestId,
      details: { reason: 'exposure_amount_invalid', field: 'exposure_amount' },
    });
  }
  if (!isIso4217Currency(terms.exposure_currency)) {
    throw new AramoError('PERMANENT_PLACEMENT_EXPOSURE_INVALID', 'guarantee exposure_currency must be an active ISO-4217 code', 422, {
      requestId,
      details: { reason: 'exposure_currency_invalid', field: 'exposure_currency' },
    });
  }

  return {
    guarantee_start_date: start,
    guarantee_duration_days: duration,
    guarantee_end_date: end,
    remedy_policy: terms.remedy_policy,
    guarantee_exposure_amount: terms.exposure_amount,
    guarantee_exposure_currency: terms.exposure_currency,
    terms_source: terms.terms_source,
    recorded_by,
  };
}
