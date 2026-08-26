// COMM-B5 — dedicated E.164 normalizer for outbound call DIALING.
//
// This is intentionally a SEPARATE contract from `normalizePhone` (the
// digit-strip within-tenant match key, which must NEVER change): that helper is
// a stricter-is-safer equality key; THIS one produces a dialable destination and
// is fail-closed — it REFUSES (throws `E164NormalizationError`) anything it
// cannot confidently qualify, so a caller refuses the call before any provider
// side effect rather than dialing arbitrary digits.
//
// Explicit assumptions (documented so the failure modes are auditable):
//   1. A leading `+` marks an ALREADY-qualified international number. We validate
//      it (8..15 digits after the `+`, digits only) and strip formatting — we do
//      NOT re-infer or rewrite its country code.
//   2. A plus-less number is interpreted under the default region, which is NANP
//      (US/Canada, country code 1) and nothing else. Only an unambiguous NANP
//      number (10 significant digits, or 11 with a leading `1`) is accepted; the
//      area code and exchange leading digits must be 2-9 per the NANP rule.
//   3. Anything else — too short, too long, ambiguous length, non-digits, a
//      plus-less non-NANP number — is REFUSED. We never guess a country.
//
// This is deliberately NOT libphonenumber (no new dependency, no data tables);
// it is a conservative, explicit normalizer for the numbers this platform dials.

/** Why an input could not be turned into a dialable E.164 number. */
export type E164NormalizationReason = 'empty' | 'not_normalizable';

/** Thrown when input cannot be confidently normalized to a dialable E.164 number. */
export class E164NormalizationError extends Error {
  readonly reason: E164NormalizationReason;

  constructor(reason: E164NormalizationReason, message: string) {
    super(message);
    this.name = 'E164NormalizationError';
    this.reason = reason;
  }
}

export interface E164NormalizeOptions {
  /** The region assumed for plus-less input. Only NANP ('US') is supported. */
  readonly defaultRegion?: 'US';
}

const E164_MIN_DIGITS = 8; // shortest plausible international significant length
const E164_MAX_DIGITS = 15; // ITU-T E.164 hard maximum (incl. country code)

/** A NANP subscriber number: area code + exchange both lead with 2-9. */
function isValidNanpNationalNumber(tenDigits: string): boolean {
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(tenDigits);
}

/**
 * Normalize a raw phone string to a dialable E.164 number (e.g. `+15552345678`).
 * Throws `E164NormalizationError` when the input cannot be confidently qualified;
 * callers MUST treat that as a refusal to dial.
 */
export function normalizeToE164(raw: string, options: E164NormalizeOptions = {}): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new E164NormalizationError('empty', 'phone number is empty');
  }

  const hasPlus = trimmed.startsWith('+');
  // Strip common formatting; keep only the significant digits.
  const digits = trimmed.replace(/\D+/g, '');

  if (hasPlus) {
    // Already international: validate length/shape, do not re-infer country.
    if (digits.length < E164_MIN_DIGITS || digits.length > E164_MAX_DIGITS) {
      throw new E164NormalizationError(
        'not_normalizable',
        'international number is not a valid E.164 length',
      );
    }
    return `+${digits}`;
  }

  // Plus-less: only an unambiguous NANP number is accepted.
  const region = options.defaultRegion ?? 'US';
  if (region !== 'US') {
    throw new E164NormalizationError('not_normalizable', 'unsupported default region');
  }

  let national = digits;
  if (national.length === 11 && national.startsWith('1')) {
    national = national.slice(1);
  }
  if (national.length !== 10 || !isValidNanpNationalNumber(national)) {
    throw new E164NormalizationError(
      'not_normalizable',
      'plus-less number is not an unambiguous NANP number',
    );
  }
  return `+1${national}`;
}
