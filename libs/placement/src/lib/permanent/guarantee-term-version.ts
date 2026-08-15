// Track 7 / T7-P3 — reusable guarantee-term-version domain types + PURE validation
// (directive §3 / §4). No I/O, no DB. The version is the reusable, effective-dated,
// placement-owned source of permanent-placement guarantee terms keyed by
// (tenant_id, requisition_id); the immutable PermanentPlacement snapshot copies the
// resolved values at activation (§7). Effective windows are CALENDAR DATE, half-open
// [effective_from, effective_to) (§3.2) — the guarantee-window convention.
//
// Fail-closed error mapping (§10):
//   - bad effective_from/effective_to / effective_to <= from -> PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID (422)
//   - non-positive guarantee_duration_days                    -> PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID (422, reused)
//   - bad exposure amount / currency                          -> PERMANENT_PLACEMENT_EXPOSURE_INVALID (422, reused)
//   - source_type outside the closed registry                 -> VALIDATION_ERROR (400)

import { AramoError, isIso4217Currency } from '@aramo/common';

import { REMEDY_POLICIES, type RemedyPolicy } from '../lifecycle/placement-lifecycle.js';

import {
  isGuaranteeTermsSourceType,
  type GuaranteeTermsSourceType,
} from './guarantee-terms-source.js';

// Decimal money string, never a float: Decimal(12,2) — the exposure column convention.
const MONEY_12_2 = /^\d{1,10}(\.\d{1,2})?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const OPTIONAL_TEXT_MAX = 255;

// The read projection (§8). Dates are ISO calendar strings; instants are ISO-8601.
export interface GuaranteeTermVersionView {
  readonly id: string;
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly guarantee_duration_days: number;
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string;
  readonly currency: string;
  readonly source_type: GuaranteeTermsSourceType;
  readonly source_reference: string | null;
  readonly source_version: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly supersedes_version_id: string | null;
  readonly correlation_id: string | null;
  readonly created_at: string;
}

// The reusable term payload + provenance common to create + revise (§3.3 / §3.6).
export interface GuaranteeTermPayloadInput {
  readonly guarantee_duration_days: number;
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string;
  readonly currency: string;
  readonly source_type: string;
  readonly source_reference?: string | null;
  readonly source_version?: string | null;
  readonly correlation_id?: string | null;
}

// Create the initial (open) version for a (tenant, requisition) (§8 POST). effective_from
// is the calendar date the terms become effective; the version is open (effective_to NULL)
// until a governed revision first-closes it.
export interface CreateGuaranteeTermVersionInput extends GuaranteeTermPayloadInput {
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly effective_from: string;
  readonly recorded_by: string;
}

// Revise the current open version (§8 POST /revise): first-close the predecessor at
// effective_from and insert the successor [effective_from, NULL) atomically.
export interface ReviseGuaranteeTermVersionInput extends GuaranteeTermPayloadInput {
  readonly tenant_id: string;
  readonly requisition_id: string;
  readonly effective_from: string;
  readonly recorded_by: string;
}

// The resolved terms copied into the PermanentPlacement snapshot at activation (§7).
export interface ResolvedGuaranteeTerms {
  readonly guarantee_term_version_id: string;
  readonly guarantee_duration_days: number;
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string;
  readonly currency: string;
  readonly source_type: GuaranteeTermsSourceType;
  readonly source_reference: string | null;
  readonly source_version: string | null;
}

// A validated, normalised payload ready for persistence.
export interface ValidatedGuaranteeTermPayload {
  readonly guarantee_duration_days: number;
  readonly remedy_policy: RemedyPolicy;
  readonly guarantee_exposure_amount: string;
  readonly currency: string;
  readonly source_type: GuaranteeTermsSourceType;
  readonly source_reference: string | null;
  readonly source_version: string | null;
  readonly correlation_id: string | null;
}

function termsWindowInvalid(requestId: string, reason: string, extra: Record<string, unknown> = {}): AramoError {
  return new AramoError(
    'PERMANENT_PLACEMENT_TERMS_WINDOW_INVALID',
    'the guarantee-term effective window is invalid',
    422,
    { requestId, details: { reason, ...extra } },
  );
}

// Parse a strict yyyy-mm-dd into a UTC-midnight Date, or null if malformed /
// non-round-tripping (2026-02-30). The T7 calendar convention — all arithmetic in UTC.
export function parseTermCalendarDate(value: string): Date | null {
  if (!ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== value) return null;
  return d;
}

function normaliseOptionalText(value: string | null | undefined, field: string, requestId: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new AramoError('VALIDATION_ERROR', `${field} must be a string`, 400, { requestId, details: { field } });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > OPTIONAL_TEXT_MAX) {
    throw new AramoError('VALIDATION_ERROR', `${field} is too long`, 400, { requestId, details: { field } });
  }
  return trimmed;
}

// Validate the reusable guarantee-term payload + provenance (shared by create + revise),
// or throw a fail-closed AramoError. Does NOT validate the effective window (the command
// owns that — create validates effective_from, revise validates the first-close boundary).
export function validateGuaranteeTermPayload(
  input: GuaranteeTermPayloadInput,
  requestId: string,
): ValidatedGuaranteeTermPayload {
  const duration = input.guarantee_duration_days;
  if (!Number.isInteger(duration) || duration <= 0) {
    throw new AramoError(
      'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID',
      'guarantee_duration_days must be a positive integer',
      422,
      { requestId, details: { reason: 'duration_not_positive_integer', guarantee_duration_days: duration } },
    );
  }

  if (!(REMEDY_POLICIES as readonly string[]).includes(input.remedy_policy)) {
    throw new AramoError(
      'PERMANENT_PLACEMENT_GUARANTEE_WINDOW_INVALID',
      'remedy_policy must be exactly one of REPLACEMENT, REFUND, PRORATED_CREDIT',
      422,
      { requestId, details: { reason: 'remedy_policy_invalid', remedy_policy: input.remedy_policy } },
    );
  }

  if (typeof input.guarantee_exposure_amount !== 'string' || !MONEY_12_2.test(input.guarantee_exposure_amount)) {
    throw new AramoError(
      'PERMANENT_PLACEMENT_EXPOSURE_INVALID',
      'guarantee_exposure_amount must be a non-negative Decimal(12,2) money string',
      422,
      { requestId, details: { reason: 'exposure_amount_invalid', field: 'guarantee_exposure_amount' } },
    );
  }
  if (!isIso4217Currency(input.currency)) {
    throw new AramoError('PERMANENT_PLACEMENT_EXPOSURE_INVALID', 'currency must be an active ISO-4217 code', 422, {
      requestId,
      details: { reason: 'currency_invalid', field: 'currency' },
    });
  }

  if (!isGuaranteeTermsSourceType(input.source_type)) {
    throw new AramoError('VALIDATION_ERROR', 'source_type must be one of the governed registry values (MANUAL, IMPORTED)', 400, {
      requestId,
      details: { field: 'source_type', source_type: input.source_type },
    });
  }

  return {
    guarantee_duration_days: duration,
    remedy_policy: input.remedy_policy,
    guarantee_exposure_amount: input.guarantee_exposure_amount,
    currency: input.currency,
    source_type: input.source_type,
    source_reference: normaliseOptionalText(input.source_reference, 'source_reference', requestId),
    source_version: normaliseOptionalText(input.source_version, 'source_version', requestId),
    correlation_id: normaliseOptionalText(input.correlation_id, 'correlation_id', requestId),
  };
}

// Validate an effective-window start date (create + revise), returning the UTC-midnight Date.
export function validateEffectiveFrom(value: string, requestId: string): Date {
  const parsed = parseTermCalendarDate(value);
  if (parsed === null) throw termsWindowInvalid(requestId, 'effective_from_invalid', { effective_from: value });
  return parsed;
}

export { termsWindowInvalid };
