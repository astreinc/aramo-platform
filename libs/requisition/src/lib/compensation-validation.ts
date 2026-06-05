import { AramoError } from '@aramo/common';

import { isIso4217Currency } from './dto/iso-4217-currency.js';
import { isRatePeriod } from './dto/rate-period.js';
import { isRequisitionCompensationModel } from './dto/requisition-compensation-model.js';

// Compensation-Field Modeling v1.1 — controller-boundary validation.
//
// The directive (v1.0 §2.3 carried into v1.1) calls for a CLOSED-SET
// guard on currencies — not a Postgres enum (the ISO-4217 list
// evolves), but a runtime check at the API boundary. We extend the
// same closed-set discipline to the comp-model + rate-period values
// so an invalid string surfaces as a clean VALIDATION_ERROR (400)
// instead of an opaque Prisma coercion failure (500-class).
//
// Decimal strings (amounts/percents) are validated as parseable
// non-negative decimals: rejects "abc", scientific notation, and
// negatives (a placement_fee_amount of -10 is nonsense at this
// batch). v1.1 §10 halt-adjacent: keep the boundary tight so the
// projectView compute has well-formed inputs.

// Shape that both create + update DTOs satisfy — every comp field
// optional and undefined-or-null is "not set". The validator inspects
// only fields the caller actually provided.
export interface CompensationValidatable {
  compensation_model?: string | null;
  pay_rate_amount?: string | null;
  pay_rate_currency?: string | null;
  pay_rate_period?: string | null;
  bill_rate_amount?: string | null;
  bill_rate_currency?: string | null;
  bill_rate_period?: string | null;
  placement_fee_percent?: string | null;
  placement_fee_amount?: string | null;
  salary_amount?: string | null;
  salary_currency?: string | null;
}

// Match a non-negative decimal with up to 12 integer digits + up to 4
// fractional digits. Covers the Decimal(12,2) and Decimal(5,2) column
// widths used by this batch with slack for the percent guard.
const DECIMAL_RE = /^\d{1,12}(?:\.\d{1,4})?$/;

function reject(requestId: string, field: string, reason: string): never {
  throw new AramoError(
    'VALIDATION_ERROR',
    `Invalid ${field}: ${reason}`,
    400,
    { requestId, details: { field } },
  );
}

function checkDecimal(
  requestId: string,
  field: string,
  value: string | null | undefined,
): void {
  if (value === undefined || value === null) return;
  if (!DECIMAL_RE.test(value)) {
    reject(requestId, field, 'must be a non-negative decimal string');
  }
}

function checkCurrency(
  requestId: string,
  field: string,
  value: string | null | undefined,
): void {
  if (value === undefined || value === null) return;
  if (!isIso4217Currency(value)) {
    reject(requestId, field, 'must be an ISO-4217 currency code');
  }
}

function checkRatePeriod(
  requestId: string,
  field: string,
  value: string | null | undefined,
): void {
  if (value === undefined || value === null) return;
  if (!isRatePeriod(value)) {
    reject(requestId, field, 'must be one of HOURLY|DAILY|WEEKLY|MONTHLY|ANNUAL');
  }
}

export function validateCompensationInput(
  input: CompensationValidatable,
  requestId: string,
): void {
  if (
    input.compensation_model !== undefined &&
    input.compensation_model !== null &&
    !isRequisitionCompensationModel(input.compensation_model)
  ) {
    reject(requestId, 'compensation_model', 'must be CONTRACT or PERMANENT');
  }
  checkDecimal(requestId, 'pay_rate_amount', input.pay_rate_amount);
  checkCurrency(requestId, 'pay_rate_currency', input.pay_rate_currency);
  checkRatePeriod(requestId, 'pay_rate_period', input.pay_rate_period);
  checkDecimal(requestId, 'bill_rate_amount', input.bill_rate_amount);
  checkCurrency(requestId, 'bill_rate_currency', input.bill_rate_currency);
  checkRatePeriod(requestId, 'bill_rate_period', input.bill_rate_period);
  checkDecimal(requestId, 'placement_fee_percent', input.placement_fee_percent);
  checkDecimal(requestId, 'placement_fee_amount', input.placement_fee_amount);
  checkDecimal(requestId, 'salary_amount', input.salary_amount);
  checkCurrency(requestId, 'salary_currency', input.salary_currency);
}
