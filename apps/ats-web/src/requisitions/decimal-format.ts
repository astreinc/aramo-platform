// Hand-mirrored from libs/requisition/src/lib/compensation-validation.ts:42.
// Money fields are sent as decimal strings (NOT numbers — see
// create-requisition-request.dto.ts:40 "Decimal money fields are
// accepted as strings to preserve precision over the wire"). The BE
// regex rejects scientific notation, negatives, and over-precision.
//
// The form uses <input type="text" inputMode="decimal" pattern={...}>
// — NOT type=number (forces float-coercion and loses precision).

export const DECIMAL_PATTERN = '^\\d{1,12}(?:\\.\\d{1,4})?$';
const DECIMAL_RE = new RegExp(`^${DECIMAL_PATTERN.replace(/^\^|\$$/g, '')}$`);

export function isValidDecimal(value: string): boolean {
  return DECIMAL_RE.test(value);
}
