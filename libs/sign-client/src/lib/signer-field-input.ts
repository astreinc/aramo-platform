// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 — what a
// SIGNER sees and does with a field, ONE copy for the sign-web guest page and the Aramo Sign app:
//   - signerInputKind: which control fills the field (the date picker, the choice list, …);
//   - signerValueProblem: the client check before a value is sent (the server's own rules,
//     @aramo/sign-fields fieldValueRefusal and the M-A12 profile rule, so a value the page
//     accepts is a value the server accepts);
//   - fieldValueRefusalText: a value refusal (client check or the server's VALIDATION_ERROR
//     details.reason) in plain language, with the field's own limits where it has them;
//   - signerUnitMessage / incompleteReasonMessage: the completion rules in plain language
//     (radio_group_select_one included);
//   - normalizeSignerInput, fieldInputLimit, fieldInputHint, dropdownChoicesOf: input helpers.
// The server stays the authority; this file only words its rules.

import {
  MULTILINE_TEXT_MAX,
  fieldValueRefusal,
  formatChosenDate,
  formatNumberValue,
  type DropdownChoice,
  type FieldOptions,
} from '@aramo/sign-fields';

import { PROFILE_TEXT_FIELD_TYPES, PROFILE_TEXT_MAX, isSignerLocked, profileTextValueRefusal, type FieldRuleViolation } from './field-rules.js';

/** The parts of a signer field the input rules read (the signer view's field shape). */
export interface SignerInputField {
  readonly field_type: string;
  readonly label?: string | null;
  readonly tooltip?: string | null;
  readonly placeholder?: string | null;
  readonly validation?: string | null;
  readonly options?: FieldOptions | Readonly<Record<string, unknown>> | null;
  readonly read_only?: boolean | null;
  readonly sender_filled?: boolean | null;
}

/** The control a signer fills a field with. */
export type SignerInputKind =
  | 'signature'
  | 'initials'
  | 'sign_date'
  | 'check'
  | 'acknowledge'
  | 'radio'
  | 'date'
  | 'dropdown'
  | 'number'
  | 'multiline'
  | 'text'
  | 'payment';

const PROFILE: ReadonlySet<string> = new Set(PROFILE_TEXT_FIELD_TYPES);

export function signerInputKind(fieldType: string): SignerInputKind {
  switch (fieldType) {
    case 'SIGNATURE':
      return 'signature';
    case 'INITIALS':
      return 'initials';
    case 'SIGN_DATE':
      return 'sign_date';
    case 'CHECKBOX':
      return 'check';
    case 'ACKNOWLEDGEMENT':
      return 'acknowledge';
    case 'RADIO':
      return 'radio';
    case 'DATE':
      return 'date';
    case 'DROPDOWN':
      return 'dropdown';
    case 'NUMBER':
      return 'number';
    case 'MULTILINE_TEXT':
      return 'multiline';
    case 'PAYMENT':
      return 'payment';
    default:
      return 'text';
  }
}

/** A field whose value the signer picks or types in an editor (the text sheet / dialog family). */
export function isSignerEditorKind(kind: SignerInputKind): kind is 'date' | 'dropdown' | 'number' | 'multiline' | 'text' {
  return kind === 'date' || kind === 'dropdown' || kind === 'number' || kind === 'multiline' || kind === 'text';
}

function optionsOf(f: SignerInputField): FieldOptions {
  return (f.options ?? {}) as FieldOptions;
}

/** The field's caption: its label setting when it has one (S-1), else null (the client names the type). */
export function signerFieldCaption(f: Pick<SignerInputField, 'label'>): string | null {
  return typeof f.label === 'string' && f.label.trim().length > 0 ? f.label.trim() : null;
}

/** The help text the sender wrote (S-1 tooltip), or null. */
export function signerFieldTooltip(f: Pick<SignerInputField, 'tooltip'>): string | null {
  return typeof f.tooltip === 'string' && f.tooltip.trim().length > 0 ? f.tooltip.trim() : null;
}

/** The placeholder hint (S-2), or null. */
export function signerFieldPlaceholder(f: Pick<SignerInputField, 'placeholder'>): string | null {
  return typeof f.placeholder === 'string' && f.placeholder.length > 0 ? f.placeholder : null;
}

/** S-4 / S-5 — the sender's value, shown and never editable or required of the signer. */
export const isSenderValueField = (f: Pick<SignerInputField, 'read_only' | 'sender_filled'>): boolean => isSignerLocked(f);

/** The DROPDOWN's choices (a plain string is shorthand for {value, label: value}). */
export function dropdownChoicesOf(f: SignerInputField): DropdownChoice[] {
  const raw = (optionsOf(f).choices ?? []) as readonly unknown[];
  const out: DropdownChoice[] = [];
  for (const c of raw) {
    if (typeof c === 'string') out.push({ value: c, label: c });
    else if (c !== null && typeof c === 'object' && typeof (c as { value?: unknown }).value === 'string') {
      const value = (c as { value: string }).value;
      const label = (c as { label?: unknown }).label;
      out.push({ value, label: typeof label === 'string' && label.length > 0 ? label : value });
    }
  }
  return out;
}

/** The most characters the input takes, or null when the server sets no length rule. */
export function fieldInputLimit(f: SignerInputField): number | null {
  const o = optionsOf(f);
  const preset = f.validation === 'max_length' && typeof o.max_length === 'number' ? o.max_length : null;
  if (f.field_type === 'MULTILINE_TEXT') return preset !== null ? Math.min(preset, MULTILINE_TEXT_MAX) : MULTILINE_TEXT_MAX;
  if (f.field_type === 'TEXT') return preset;
  if (PROFILE.has(f.field_type) || f.field_type === 'SIGNER_NAME') return PROFILE_TEXT_MAX;
  return null;
}

function cap(s: string): string {
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

/** A NUMBER's range ("from $1.00 to $500.00", "at least 1", "at most 10"), or null. */
function numberRangePhrase(f: SignerInputField): string | null {
  const o = optionsOf(f);
  if (f.field_type !== 'NUMBER' || f.validation !== 'number_range') return null;
  const fmt = (n: number) => formatNumberValue(String(n), o);
  if (o.min !== undefined && o.max !== undefined) return `from ${fmt(o.min)} to ${fmt(o.max)}`;
  if (o.min !== undefined) return `at least ${fmt(o.min)}`;
  if (o.max !== undefined) return `at most ${fmt(o.max)}`;
  return null;
}

/** A DATE's range in the envelope's date format ("from 01/02/2026 to 03/04/2026", …), or null. */
function dateRangePhrase(f: SignerInputField, dateFormat: string | null | undefined): string | null {
  const o = optionsOf(f);
  if (f.field_type !== 'DATE' || f.validation !== 'date_range') return null;
  const fmt = (d: string) => formatChosenDate(d, dateFormat);
  if (o.min_date !== undefined && o.max_date !== undefined) return `from ${fmt(o.min_date)} to ${fmt(o.max_date)}`;
  if (o.min_date !== undefined) return `on or after ${fmt(o.min_date)}`;
  if (o.max_date !== undefined) return `on or before ${fmt(o.max_date)}`;
  return null;
}

/** "Amount in USD · From 1 to 10", "From 01/02/2026 to 03/04/2026", "Up to 50 characters" — or null. */
export function fieldInputHint(f: SignerInputField, ctx: { readonly date_format?: string | null } = {}): string | null {
  const o = optionsOf(f);
  const parts: string[] = [];
  if (f.field_type === 'NUMBER') {
    if (o.format === 'money') parts.push(`Amount in ${o.currency ?? 'USD'}`);
    const range = numberRangePhrase(f);
    if (range !== null) parts.push(cap(range));
    if (o.decimals === 0) parts.push('Whole numbers only');
  }
  const dates = dateRangePhrase(f, ctx.date_format);
  if (dates !== null) parts.push(cap(dates));
  if (f.field_type === 'TEXT') {
    if (f.validation === 'email') parts.push('An email address');
    if (f.validation === 'phone') parts.push('A phone number');
    if (f.validation === 'us_zip') parts.push('A US ZIP code');
  }
  if ((f.field_type === 'TEXT' || f.field_type === 'MULTILINE_TEXT') && f.validation === 'max_length' && typeof o.max_length === 'number') {
    parts.push(`Up to ${o.max_length} characters`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** The date bounds a DATE picker honours (date_range), as YYYY-MM-DD. */
export function dateBoundsOf(f: SignerInputField): { readonly min: string | null; readonly max: string | null } {
  const o = optionsOf(f);
  if (f.validation !== 'date_range') return { min: null, max: null };
  return { min: o.min_date ?? null, max: o.max_date ?? null };
}

/** The money prefix a NUMBER input shows ("$", "€", or the currency code), or null for a plain number. */
export function numberPrefixOf(f: SignerInputField): string | null {
  const o = optionsOf(f);
  if (f.field_type !== 'NUMBER' || o.format !== 'money') return null;
  // formatNumberValue('0') is the symbol (or "CODE ") followed by the digits.
  return formatNumberValue('0', { ...o, decimals: 0 }).replace(/0$/, '').trim();
}

/**
 * The value a signer's typing becomes before it is checked and sent. NUMBER: grouping commas,
 * spaces and a currency symbol are dropped ("$1,250.5" → "1250.5"; ".5" → "0.5"). Every other
 * type: trimmed (MULTILINE_TEXT keeps its inner line breaks).
 */
export function normalizeSignerInput(f: Pick<SignerInputField, 'field_type'>, raw: string): string {
  const v = raw.trim();
  if (f.field_type !== 'NUMBER') return v;
  // Drop spaces and grouping commas, then a currency prefix on either side of a minus sign.
  const m = /^(-?)[^\d.-]*(-?)(.*)$/.exec(v.replace(/[\s,]/g, ''));
  let n = m === null ? v : `${m[1] === '-' || m[2] === '-' ? '-' : ''}${m[3] ?? ''}`;
  if (n.startsWith('-.')) n = `-0${n.slice(1)}`;
  else if (n.startsWith('.')) n = `0${n}`;
  if (n.endsWith('.')) n = n.slice(0, -1);
  // Nothing numeric left: keep the typing, so the check names the problem.
  if (n.length === 0) return v;
  return n;
}

/** The server reasons a single field's value can be refused for (fill), worded below. */
export const SIGNER_FIELD_VALUE_COPY: Readonly<Record<string, string>> = {
  checkbox_value_invalid: 'This box can only be checked or unchecked.',
  date_value_invalid: 'Choose a valid date.',
  number_value_invalid: 'Enter a number, like 42 or 3.5.',
  number_decimals_exceeded: 'Use fewer decimal places.',
  dropdown_value_invalid: 'Choose one of the options.',
  multiline_text_too_long: `Enter at most ${MULTILINE_TEXT_MAX} characters.`,
  validation_email_failed: 'Enter a valid email address, like name@example.com.',
  validation_phone_failed: 'Enter a valid phone number, with 7 to 15 digits.',
  validation_us_zip_failed: 'Enter a US ZIP code, like 12345 or 12345-6789.',
  validation_max_length_failed: 'Enter fewer characters.',
  validation_number_range_failed: 'Enter a number in the allowed range.',
  validation_date_range_failed: 'Choose a date in the allowed range.',
  profile_field_value_invalid: `Enter at most ${PROFILE_TEXT_MAX} characters.`,
  email_field_value_invalid: 'Enter a valid email address, like name@example.com.',
  field_read_only: 'The sender filled in this field. It can’t be changed.',
  signer_profile_name_server_filled: 'Your name is filled in from the signing request.',
  payment_field_server_filled: 'This field is completed when you pay.',
  // FIELD-PARITY-2 B-5 / B-6 — the fill was refused because the signer's answers hide this field
  // (its "show only when" rule is not met); the server is the authority.
  field_hidden: 'This field isn’t needed for your answers, so it’s hidden now.',
  // FIELD-PARITY-2 B-6 follow-up — a stored value of this kind is not emptied (a box or a choice
  // is unchecked with 'false'; a signature, initials or date signed is replaced, not emptied).
  field_clear_not_allowed: 'This field can’t be emptied. Change it instead.',
};

export const SIGNER_FIELD_VALUE_FALLBACK = 'This value can’t be used here. Check it and try again.';

/**
 * A value refusal in plain language. With the field, the message names its own limits (the
 * range, the decimals, the length); without it, the general wording.
 */
export function fieldValueRefusalText(reason: string | null | undefined, f?: SignerInputField | null, ctx: { readonly date_format?: string | null } = {}): string {
  const o = f ? optionsOf(f) : {};
  if (f) {
    if (reason === 'validation_number_range_failed') {
      const range = numberRangePhrase(f);
      if (range !== null) return `Enter a number ${range}.`;
    }
    if (reason === 'validation_date_range_failed') {
      const range = dateRangePhrase(f, ctx.date_format);
      if (range !== null) return `Choose a date ${range}.`;
    }
    if (reason === 'number_decimals_exceeded' && typeof o.decimals === 'number') {
      return o.decimals === 0 ? 'Enter a whole number.' : `Use at most ${o.decimals} decimal place${o.decimals === 1 ? '' : 's'}.`;
    }
    if (reason === 'validation_max_length_failed' && typeof o.max_length === 'number') return `Enter at most ${o.max_length} characters.`;
  }
  return (reason ? SIGNER_FIELD_VALUE_COPY[reason] : undefined) ?? SIGNER_FIELD_VALUE_FALLBACK;
}

/** True for a reason this file words (a refusal about one field's value). */
export function isFieldValueRefusalReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && SIGNER_FIELD_VALUE_COPY[reason] !== undefined;
}

/**
 * The client check before a value is sent: the reason the server would refuse it, or null.
 * An empty value is never a format problem (a required field is the completion rule's).
 */
export function signerValueProblem(f: SignerInputField, value: string): string | null {
  if (isSignerLocked(f)) return 'field_read_only';
  if (value.trim().length === 0 && f.field_type !== 'CHECKBOX' && f.field_type !== 'RADIO' && f.field_type !== 'ACKNOWLEDGEMENT') return null;
  const profile = profileTextValueRefusal(f.field_type, value);
  if (profile !== null) return profile;
  return fieldValueRefusal({ field_type: f.field_type, validation: f.validation ?? null, options: f.options ?? null }, value);
}

/** The parts of a field the clear rule reads (the stored row and the signer view both have them). */
export interface SignerClearField {
  readonly field_type: string;
  readonly name_mode?: string | null;
  readonly server_filled?: boolean | null;
  readonly read_only?: boolean | null;
  readonly sender_filled?: boolean | null;
}

/**
 * FIELD-PARITY-2 B-6 follow-up (ruling C-3) — the reason the signer may NOT clear a stored value
 * (the fill call with value null), or null when they may. ONE rule: the server refuses with it,
 * and the signer apps send a clear only when it is null.
 *   - Only a value the signer types or picks in the field editor is cleared: text, the profile
 *     types, a typed name, DATE, DROPDOWN, NUMBER, MULTILINE_TEXT — required or not (completion
 *     still requires a required one).
 *   - A box or a radio option is unchecked with 'false' as before; a SIGNATURE, INITIALS or
 *     SIGN_DATE is replaced, never emptied: field_clear_not_allowed.
 *   - The server's or the sender's values keep their own reasons (signer_profile_name_server_filled,
 *     payment_field_server_filled, field_read_only).
 */
export function signerClearRefusal(f: SignerClearField): string | null {
  if (f.field_type === 'PAYMENT') return 'payment_field_server_filled';
  if ((f.field_type === 'SIGNER_NAME' && f.name_mode === 'SIGNER_PROFILE') || f.server_filled === true) return 'signer_profile_name_server_filled';
  if (isSignerLocked(f)) return 'field_read_only';
  return isSignerEditorKind(signerInputKind(f.field_type)) ? null : 'field_clear_not_allowed';
}

/** One completion rule a signer has not met yet, in plain language. */
export function signerUnitMessage(
  reason: FieldRuleViolation['reason'],
  ctx: { readonly checked?: number; readonly min_selected?: number; readonly label?: string | null } = {},
): string {
  switch (reason) {
    case 'radio_group_select_one':
      return (ctx.checked ?? 0) > 1 ? 'Choose only one option in each set of choices.' : 'Choose one option in each required set of choices.';
    case 'checkbox_group_select_one':
      return (ctx.checked ?? 0) > 1 ? 'Choose only one option in each “select one” group.' : 'Choose one option in each required group.';
    case 'checkbox_group_min_selected': {
      const min = Math.max(1, ctx.min_selected ?? 1);
      return `Check at least ${min} option${min === 1 ? '' : 's'} in each required group.`;
    }
    case 'payment_required':
      return 'A payment is required before you can finish.';
    case 'checkbox_required_unchecked':
      return `Check the required box${ctx.label ? ` “${ctx.label}”` : ''}.`;
    default:
      return 'Some required fields still need your input.';
  }
}

/** The server's 409 SIGNATURE_FIELD_INCOMPLETE details.reason, in plain language. */
export function incompleteReasonMessage(reason: string | null | undefined): string {
  switch (reason) {
    case 'checkbox_required_unchecked':
      return 'A required box still needs to be checked.';
    case 'checkbox_group_select_one':
      return 'Choose exactly one option in each “select one” group.';
    case 'radio_group_select_one':
      return 'Choose exactly one option in each set of choices.';
    case 'checkbox_group_min_selected':
      return 'Check enough options in each required group.';
    case 'payment_required':
      return 'A payment is required before you can finish.';
    default:
      return 'Some required fields still need your input.';
  }
}
