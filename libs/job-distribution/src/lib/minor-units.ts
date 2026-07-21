// SRC-2 PR-3 (DEV-D) — advertised-pay decimal-string → integer minor units.
//
// Indeed's Job Sync `salary` input carries `minimumMinor` as an INTEGER in the
// currency's minor unit (e.g. USD cents). Our `advertised_pay_*` columns are
// Decimal(12,2), so a value arrives as a decimal STRING (e.g. "80.00"). The
// conversion is done by STRING ARITHMETIC — shifting the decimal point — never
// via float math: `Number("80.05") * 100` is 8004.999999999999, an off-by-cent
// waiting to happen. This module has ZERO imports (no @aramo edge; the lib stays
// buildable-import-free).
//
// STATED RULE (Gate-6): the source column is Decimal(12,2), so a faithful value
// has at most 2 fractional digits. We REJECT (throw) on >2 fractional digits
// rather than round — advertised comp is an authored public statement and must
// never be silently distorted. A rejected value bubbles up as that requisition's
// posting ERROR (re-enterable), it never corrupts the payload. Examples proven by
// the unit spec: "80.00" → 8000, "80.5" → 8050, "80.055" → InvalidMinorUnitsError.

export class InvalidMinorUnitsError extends Error {
  constructor(value: string, reason: string) {
    super(`invalid minor-units input "${value}": ${reason}`);
    this.name = 'InvalidMinorUnitsError';
  }
}

export function decimalStringToMinorUnits(value: string): number {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new InvalidMinorUnitsError(value, 'not a decimal number');
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPart, fracPartRaw = ''] = unsigned.split('.');
  if (fracPartRaw.length > 2) {
    throw new InvalidMinorUnitsError(value, 'more than 2 fractional digits');
  }
  // "5" → "50", "" → "00": pad to exactly 2 minor digits.
  const frac = fracPartRaw.padEnd(2, '0');
  // Strip leading zeros but keep at least one digit ("0000" → "0").
  const minorStr = `${intPart}${frac}`.replace(/^0+(?=\d)/, '');
  const minor = Number(minorStr);
  return negative ? -minor : minor;
}
