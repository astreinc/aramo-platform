// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 — the
// value rules of the Phase 3 types and settings, ONE copy for the server (signer fill, sender-
// filled values, completion) and every signer UI:
//   - fieldValueRefusal: whether a value may be stored in a field (type format + validation
//     preset), with a stable reason;
//   - fieldValueDisplay: how a stored value is printed on the executed PDF and the completion
//     certificate (DATE in the envelope's date format, NUMBER formatted, money with its
//     currency, DROPDOWN as the chosen choice's label).
//
// Stored value formats (canonical, what a client sends):
//   CHECKBOX / RADIO / ACKNOWLEDGEMENT  'true' | 'false'
//   DATE                                'YYYY-MM-DD' (a real calendar date)
//   NUMBER                              a decimal: optional '-', digits, optional '.' digits
//   DROPDOWN                            one choice's value (options.choices[].value)
//   TEXT / MULTILINE_TEXT               text (empty allowed, as TEXT always has been)
//
// A type this file does not know (SIGNATURE, the profile types, …) is left to its existing
// rule: fieldValueRefusal returns null and fieldValueDisplay returns the value unchanged.
//
// Pure TypeScript ESM, no dependency (scope:shared).

import { FIELD_CATALOG, isFieldTypeKey } from './catalog.js';
import { MULTILINE_TEXT_MAX, isIsoDate, type FieldOptions } from './field-settings.js';

export const FIELD_VALUE_REFUSAL_REASONS = [
  'checkbox_value_invalid',
  'date_value_invalid',
  'number_value_invalid',
  'number_decimals_exceeded',
  'dropdown_value_invalid',
  'multiline_text_too_long',
  'validation_email_failed',
  'validation_phone_failed',
  'validation_us_zip_failed',
  'validation_max_length_failed',
  'validation_number_range_failed',
  'validation_date_range_failed',
] as const;
export type FieldValueRefusalReason = (typeof FIELD_VALUE_REFUSAL_REASONS)[number];

/** The parts of a field its value rule reads. */
export interface FieldValueRuleField {
  readonly field_type: string;
  readonly validation?: string | null;
  readonly options?: FieldOptions | Readonly<Record<string, unknown>> | null;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const US_ZIP_RE = /^\d{5}(-\d{4})?$/;
const PHONE_CHARS_RE = /^\+?[0-9 ().-]+$/;

function optionsOf(f: FieldValueRuleField): FieldOptions {
  return (f.options ?? {}) as FieldOptions;
}

/** Whether a boolean field's stored value is 'true' or 'false'. */
function isBooleanType(t: string): boolean {
  return isFieldTypeKey(t) && FIELD_CATALOG[t].value_kind === 'boolean';
}

/**
 * The reason `value` may not be stored in the field, or null when it may. Checked on every
 * signer fill, on every sender-filled value, and by the signer UIs before they send.
 */
export function fieldValueRefusal(f: FieldValueRuleField, value: string): FieldValueRefusalReason | null {
  const t = f.field_type;
  if (isBooleanType(t)) return value === 'true' || value === 'false' ? null : 'checkbox_value_invalid';
  const o = optionsOf(f);
  const v = value.trim();
  if (t === 'DATE') {
    if (!isIsoDate(v)) return 'date_value_invalid';
    if (f.validation === 'date_range' && ((o.min_date !== undefined && v < o.min_date) || (o.max_date !== undefined && v > o.max_date))) return 'validation_date_range_failed';
    return null;
  }
  if (t === 'NUMBER') {
    if (!NUMBER_RE.test(v) || v.length > 32) return 'number_value_invalid';
    const decimals = o.decimals ?? 6;
    const frac = v.split('.')[1] ?? '';
    if (frac.length > decimals) return 'number_decimals_exceeded';
    const n = Number(v);
    if (f.validation === 'number_range' && ((o.min !== undefined && n < o.min) || (o.max !== undefined && n > o.max))) return 'validation_number_range_failed';
    return null;
  }
  if (t === 'DROPDOWN') {
    return (o.choices ?? []).some((c) => c.value === v) ? null : 'dropdown_value_invalid';
  }
  if (t === 'TEXT' || t === 'MULTILINE_TEXT') {
    if (t === 'MULTILINE_TEXT' && value.length > MULTILINE_TEXT_MAX) return 'multiline_text_too_long';
    if (v.length === 0) return null;
    switch (f.validation) {
      case 'email':
        return v.length <= 254 && EMAIL_RE.test(v) ? null : 'validation_email_failed';
      case 'phone': {
        const digits = v.replace(/\D/g, '').length;
        return PHONE_CHARS_RE.test(v) && digits >= 7 && digits <= 15 ? null : 'validation_phone_failed';
      }
      case 'us_zip':
        return US_ZIP_RE.test(v) ? null : 'validation_us_zip_failed';
      case 'max_length':
        return o.max_length !== undefined && value.length > o.max_length ? 'validation_max_length_failed' : null;
      default:
        return null;
    }
  }
  return null;
}

/** A field's value is a real entry (non-empty after trimming). */
export function hasFieldValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The date formats an envelope may use (the SIGN_DATE formats, @aramo/sign-client). */
export type FieldDateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';

/** T-3 — a stored YYYY-MM-DD in the envelope's date format (null / unknown ⇒ MM/DD/YYYY, the default). */
export function formatChosenDate(iso: string, format: string | null | undefined): string {
  if (!isIsoDate(iso)) return iso;
  const [yyyy, mm, dd] = iso.split('-') as [string, string, string];
  if (format === 'DD/MM/YYYY') return `${dd}/${mm}/${yyyy}`;
  if (format === 'YYYY-MM-DD') return iso;
  return `${mm}/${dd}/${yyyy}`;
}

const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = { USD: '$', EUR: '€', GBP: '£', INR: '₹', JPY: '¥', CAD: 'CA$', AUD: 'A$' };

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * T-6 — a stored NUMBER as printed: digits grouped by thousands, the fixed decimals when the
 * field names them, and money with its currency symbol (or code). Deterministic (no Intl), so
 * the server and every client print the same text.
 */
export function formatNumberValue(value: string, options: FieldOptions | null | undefined): string {
  const v = value.trim();
  if (!NUMBER_RE.test(v)) return value;
  const o = options ?? {};
  const negative = v.startsWith('-');
  const [intRaw = '0', fracRaw = ''] = (negative ? v.slice(1) : v).split('.');
  let frac = fracRaw;
  if (o.decimals !== undefined) frac = frac.length >= o.decimals ? frac.slice(0, o.decimals) : frac.padEnd(o.decimals, '0');
  const intPart = groupThousands(intRaw.replace(/^0+(?=\d)/, ''));
  const body = frac.length > 0 ? `${intPart}.${frac}` : intPart;
  if (o.format === 'money') {
    const cur = o.currency ?? 'USD';
    const sym = CURRENCY_SYMBOLS[cur];
    const text = sym !== undefined ? `${sym}${body}` : `${cur} ${body}`;
    return negative ? `-${text}` : text;
  }
  return negative ? `-${body}` : body;
}

/**
 * How a stored value prints on the executed PDF and the certificate. DATE in the envelope's
 * date format, NUMBER formatted, DROPDOWN as its choice's label; any other type unchanged.
 */
export function fieldValueDisplay(f: FieldValueRuleField, value: string, ctx: { readonly date_format?: string | null } = {}): string {
  const o = optionsOf(f);
  if (f.field_type === 'DATE') return formatChosenDate(value.trim(), ctx.date_format);
  if (f.field_type === 'NUMBER') return formatNumberValue(value, o);
  if (f.field_type === 'DROPDOWN') return (o.choices ?? []).find((c) => c.value === value.trim())?.label ?? value;
  return value;
}
