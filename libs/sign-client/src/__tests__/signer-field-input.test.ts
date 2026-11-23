// FIELD-PARITY-1 P3 §6 — runs under vitest and mobile Jest (globals only).
import {
  FIELD_VALUE_REFUSAL_REASONS,
  SIGNER_FIELD_VALUE_COPY,
  SIGNER_FIELD_VALUE_FALLBACK,
  dateBoundsOf,
  dropdownChoicesOf,
  fieldInputHint,
  fieldInputLimit,
  fieldValueRefusalText,
  incompleteReasonMessage,
  isFieldValueRefusalReason,
  isSenderValueField,
  isSignerEditorKind,
  normalizeSignerInput,
  numberPrefixOf,
  refusalMessage,
  signerFieldCaption,
  signerFieldPlaceholder,
  signerFieldTooltip,
  signerInputKind,
  signerClearRefusal,
  signerUnitMessage,
  signerValueProblem,
} from '../index.js';

// FIELD-PARITY-1 P3 §6 — the signer's input rules and words, one copy for both Sign clients.

describe('signerInputKind', () => {
  it('maps every signer type to its control', () => {
    expect(signerInputKind('DATE')).toBe('date');
    expect(signerInputKind('DROPDOWN')).toBe('dropdown');
    expect(signerInputKind('RADIO')).toBe('radio');
    expect(signerInputKind('NUMBER')).toBe('number');
    expect(signerInputKind('MULTILINE_TEXT')).toBe('multiline');
    expect(signerInputKind('ACKNOWLEDGEMENT')).toBe('acknowledge');
    expect(signerInputKind('CHECKBOX')).toBe('check');
    expect(signerInputKind('SIGN_DATE')).toBe('sign_date');
    expect(signerInputKind('PAYMENT')).toBe('payment');
    for (const t of ['TEXT', 'SIGNER_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE']) expect(signerInputKind(t)).toBe('text');
    expect(isSignerEditorKind('date')).toBe(true);
    expect(isSignerEditorKind('radio')).toBe(false);
  });
});

describe('settings the signer sees', () => {
  it('label, tooltip and placeholder; blank is none', () => {
    expect(signerFieldCaption({ label: ' Start date ' })).toBe('Start date');
    expect(signerFieldCaption({ label: '  ' })).toBeNull();
    expect(signerFieldCaption({})).toBeNull();
    expect(signerFieldTooltip({ tooltip: 'Your first day' })).toBe('Your first day');
    expect(signerFieldTooltip({ tooltip: null })).toBeNull();
    expect(signerFieldPlaceholder({ placeholder: 'e.g. 12' })).toBe('e.g. 12');
    expect(signerFieldPlaceholder({ placeholder: '' })).toBeNull();
  });

  it('read_only / sender_filled is the sender’s value', () => {
    expect(isSenderValueField({ sender_filled: true, read_only: true })).toBe(true);
    expect(isSenderValueField({ read_only: true })).toBe(true);
    expect(isSenderValueField({ sender_filled: false, read_only: false })).toBe(false);
    expect(signerValueProblem({ field_type: 'TEXT', read_only: true, sender_filled: true }, 'x')).toBe('field_read_only');
  });

  it('dropdown choices (string shorthand and a missing label)', () => {
    expect(dropdownChoicesOf({ field_type: 'DROPDOWN', options: { choices: ['A', { value: 'b', label: 'Bee' }, { value: 'c', label: '' }] } })).toEqual([
      { value: 'A', label: 'A' },
      { value: 'b', label: 'Bee' },
      { value: 'c', label: 'c' },
    ]);
    expect(dropdownChoicesOf({ field_type: 'DROPDOWN' })).toEqual([]);
  });

  it('input limits', () => {
    expect(fieldInputLimit({ field_type: 'MULTILINE_TEXT' })).toBe(4000);
    expect(fieldInputLimit({ field_type: 'MULTILINE_TEXT', validation: 'max_length', options: { max_length: 300 } })).toBe(300);
    expect(fieldInputLimit({ field_type: 'TEXT' })).toBeNull();
    expect(fieldInputLimit({ field_type: 'TEXT', validation: 'max_length', options: { max_length: 20 } })).toBe(20);
    expect(fieldInputLimit({ field_type: 'EMAIL' })).toBe(200);
    expect(fieldInputLimit({ field_type: 'NUMBER' })).toBeNull();
  });

  it('hints name the field’s limits in the envelope date format', () => {
    expect(fieldInputHint({ field_type: 'NUMBER', validation: 'number_range', options: { format: 'money', currency: 'USD', decimals: 2, min: 1, max: 500 } })).toBe(
      'Amount in USD · From $1.00 to $500.00',
    );
    expect(fieldInputHint({ field_type: 'NUMBER', validation: 'number_range', options: { min: 3 } })).toBe('At least 3');
    expect(fieldInputHint({ field_type: 'NUMBER', options: { decimals: 0 } })).toBe('Whole numbers only');
    expect(fieldInputHint({ field_type: 'DATE', validation: 'date_range', options: { min_date: '2026-01-02', max_date: '2026-03-04' } }, { date_format: 'DD/MM/YYYY' })).toBe(
      'From 02/01/2026 to 04/03/2026',
    );
    expect(fieldInputHint({ field_type: 'DATE', validation: 'date_range', options: { max_date: '2026-03-04' } })).toBe('On or before 03/04/2026');
    expect(fieldInputHint({ field_type: 'TEXT', validation: 'us_zip' })).toBe('A US ZIP code');
    expect(fieldInputHint({ field_type: 'MULTILINE_TEXT', validation: 'max_length', options: { max_length: 50 } })).toBe('Up to 50 characters');
    expect(fieldInputHint({ field_type: 'TEXT' })).toBeNull();
  });

  it('date bounds only with date_range', () => {
    expect(dateBoundsOf({ field_type: 'DATE', validation: 'date_range', options: { min_date: '2026-01-01' } })).toEqual({ min: '2026-01-01', max: null });
    expect(dateBoundsOf({ field_type: 'DATE', options: { min_date: '2026-01-01' } })).toEqual({ min: null, max: null });
  });

  it('money prefix', () => {
    expect(numberPrefixOf({ field_type: 'NUMBER', options: { format: 'money', currency: 'USD' } })).toBe('$');
    expect(numberPrefixOf({ field_type: 'NUMBER', options: { format: 'money', currency: 'EUR' } })).toBe('€');
    expect(numberPrefixOf({ field_type: 'NUMBER', options: { format: 'money', currency: 'CHF' } })).toBe('CHF');
    expect(numberPrefixOf({ field_type: 'NUMBER', options: { format: 'money' } })).toBe('$');
    expect(numberPrefixOf({ field_type: 'NUMBER', options: { format: 'plain' } })).toBeNull();
  });
});

describe('normalizeSignerInput', () => {
  it('NUMBER drops grouping, spaces and a currency prefix', () => {
    const n = { field_type: 'NUMBER' };
    expect(normalizeSignerInput(n, ' $1,250.5 ')).toBe('1250.5');
    expect(normalizeSignerInput(n, '.5')).toBe('0.5');
    expect(normalizeSignerInput(n, '-.5')).toBe('-0.5');
    expect(normalizeSignerInput(n, '-$3')).toBe('-3');
    expect(normalizeSignerInput(n, '$-3')).toBe('-3');
    expect(normalizeSignerInput(n, '12.')).toBe('12');
    expect(normalizeSignerInput(n, 'USD 40')).toBe('40');
    expect(normalizeSignerInput(n, 'abc')).toBe('abc');
    expect(normalizeSignerInput(n, '1e5')).toBe('1e5');
  });
  it('other types are trimmed; inner line breaks stay', () => {
    expect(normalizeSignerInput({ field_type: 'MULTILINE_TEXT' }, '  a\nb  ')).toBe('a\nb');
    expect(normalizeSignerInput({ field_type: 'DATE' }, ' 2026-01-02 ')).toBe('2026-01-02');
  });
});

describe('signerValueProblem (the server rules, before sending)', () => {
  it('DATE', () => {
    const d = { field_type: 'DATE', validation: 'date_range', options: { min_date: '2026-01-01', max_date: '2026-12-31' } };
    expect(signerValueProblem(d, '2026-06-01')).toBeNull();
    expect(signerValueProblem(d, '2025-06-01')).toBe('validation_date_range_failed');
    expect(signerValueProblem(d, '2026-02-30')).toBe('date_value_invalid');
  });
  it('NUMBER', () => {
    const n = { field_type: 'NUMBER', validation: 'number_range', options: { decimals: 2, min: 0, max: 100 } };
    expect(signerValueProblem(n, '12.5')).toBeNull();
    expect(signerValueProblem(n, '12.555')).toBe('number_decimals_exceeded');
    expect(signerValueProblem(n, '101')).toBe('validation_number_range_failed');
    expect(signerValueProblem(n, 'ten')).toBe('number_value_invalid');
  });
  it('DROPDOWN', () => {
    const d = { field_type: 'DROPDOWN', options: { choices: [{ value: 'a', label: 'A' }] } };
    expect(signerValueProblem(d, 'a')).toBeNull();
    expect(signerValueProblem(d, 'z')).toBe('dropdown_value_invalid');
  });
  it('TEXT presets and MULTILINE_TEXT', () => {
    expect(signerValueProblem({ field_type: 'TEXT', validation: 'email' }, 'nope')).toBe('validation_email_failed');
    expect(signerValueProblem({ field_type: 'TEXT', validation: 'phone' }, '12')).toBe('validation_phone_failed');
    expect(signerValueProblem({ field_type: 'TEXT', validation: 'us_zip' }, '1234')).toBe('validation_us_zip_failed');
    expect(signerValueProblem({ field_type: 'TEXT', validation: 'max_length', options: { max_length: 3 } }, 'abcd')).toBe('validation_max_length_failed');
    expect(signerValueProblem({ field_type: 'MULTILINE_TEXT' }, 'x'.repeat(4001))).toBe('multiline_text_too_long');
    expect(signerValueProblem({ field_type: 'TEXT', validation: 'email' }, '')).toBeNull();
  });
  it('profile types', () => {
    expect(signerValueProblem({ field_type: 'EMAIL' }, 'bad')).toBe('email_field_value_invalid');
    expect(signerValueProblem({ field_type: 'COMPANY' }, 'x'.repeat(201))).toBe('profile_field_value_invalid');
  });
  it('booleans (RADIO, ACKNOWLEDGEMENT)', () => {
    expect(signerValueProblem({ field_type: 'RADIO' }, 'true')).toBeNull();
    expect(signerValueProblem({ field_type: 'ACKNOWLEDGEMENT' }, 'yes')).toBe('checkbox_value_invalid');
  });
});

describe('refusal wording', () => {
  it('every server value refusal has plain-language copy, reachable through refusalMessage', () => {
    for (const r of [...FIELD_VALUE_REFUSAL_REASONS, 'field_read_only', 'profile_field_value_invalid', 'email_field_value_invalid']) {
      expect(isFieldValueRefusalReason(r)).toBe(true);
      expect(SIGNER_FIELD_VALUE_COPY[r]).toMatch(/\.$/);
      expect(refusalMessage({ code: 'VALIDATION_ERROR', reason: r, status: 400 })).toBe(SIGNER_FIELD_VALUE_COPY[r]);
    }
    expect(isFieldValueRefusalReason('something_else')).toBe(false);
    // FIELD-PARITY-2 B-6 — a fill refused because the signer's answers hide the field.
    expect(isFieldValueRefusalReason('field_hidden')).toBe(true);
    expect(fieldValueRefusalText('field_hidden')).toBe('This field isn’t needed for your answers, so it’s hidden now.');
    expect(refusalMessage({ code: 'VALIDATION_ERROR', reason: 'field_hidden', status: 400 })).toBe(SIGNER_FIELD_VALUE_COPY['field_hidden']);
    expect(fieldValueRefusalText('something_else')).toBe(SIGNER_FIELD_VALUE_FALLBACK);
  });

  it('with the field, the message names its limits', () => {
    const money = { field_type: 'NUMBER', validation: 'number_range', options: { format: 'money' as const, currency: 'USD', decimals: 2, min: 1, max: 500 } };
    expect(fieldValueRefusalText('validation_number_range_failed', money)).toBe('Enter a number from $1.00 to $500.00.');
    expect(fieldValueRefusalText('number_decimals_exceeded', money)).toBe('Use at most 2 decimal places.');
    expect(fieldValueRefusalText('number_decimals_exceeded', { field_type: 'NUMBER', options: { decimals: 0 } })).toBe('Enter a whole number.');
    expect(fieldValueRefusalText('number_decimals_exceeded', { field_type: 'NUMBER', options: { decimals: 1 } })).toBe('Use at most 1 decimal place.');
    const d = { field_type: 'DATE', validation: 'date_range', options: { min_date: '2026-01-02' } };
    expect(fieldValueRefusalText('validation_date_range_failed', d, { date_format: 'YYYY-MM-DD' })).toBe('Choose a date on or after 2026-01-02.');
    expect(fieldValueRefusalText('validation_max_length_failed', { field_type: 'TEXT', validation: 'max_length', options: { max_length: 9 } })).toBe(
      'Enter at most 9 characters.',
    );
    expect(fieldValueRefusalText('validation_number_range_failed', { field_type: 'NUMBER' })).toBe(SIGNER_FIELD_VALUE_COPY['validation_number_range_failed']);
  });

  it('completion rules, radio included', () => {
    expect(signerUnitMessage('radio_group_select_one')).toBe('Choose one option in each required set of choices.');
    expect(signerUnitMessage('radio_group_select_one', { checked: 2 })).toBe('Choose only one option in each set of choices.');
    expect(signerUnitMessage('checkbox_group_select_one', { checked: 2 })).toMatch(/only one/);
    expect(signerUnitMessage('checkbox_group_min_selected', { min_selected: 2 })).toBe('Check at least 2 options in each required group.');
    expect(signerUnitMessage('checkbox_required_unchecked', { label: 'I agree' })).toBe('Check the required box “I agree”.');
    expect(signerUnitMessage('required_field_unfilled')).toBe('Some required fields still need your input.');
    expect(incompleteReasonMessage('radio_group_select_one')).toBe('Choose exactly one option in each set of choices.');
    expect(incompleteReasonMessage(undefined)).toMatch(/required fields/);
  });
});

// FIELD-PARITY-2 B-6 follow-up — which stored values a signer may clear (value null): the one
// rule the server refuses with and both signer apps follow.
describe('signerClearRefusal', () => {
  it.each(['TEXT', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'COMPANY', 'TITLE', 'SIGNER_NAME', 'DATE', 'DROPDOWN', 'NUMBER', 'MULTILINE_TEXT'])('%s may be cleared', (field_type) => {
    expect(signerClearRefusal({ field_type })).toBeNull();
  });

  it.each(['CHECKBOX', 'ACKNOWLEDGEMENT', 'RADIO', 'SIGNATURE', 'INITIALS', 'SIGN_DATE'])('%s is not cleared (field_clear_not_allowed)', (field_type) => {
    expect(signerClearRefusal({ field_type })).toBe('field_clear_not_allowed');
  });

  it('the server’s and the sender’s values keep their own reasons', () => {
    expect(signerClearRefusal({ field_type: 'PAYMENT' })).toBe('payment_field_server_filled');
    expect(signerClearRefusal({ field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' })).toBe('signer_profile_name_server_filled');
    expect(signerClearRefusal({ field_type: 'SIGNER_NAME', server_filled: true })).toBe('signer_profile_name_server_filled');
    expect(signerClearRefusal({ field_type: 'TEXT', sender_filled: true })).toBe('field_read_only');
    expect(signerClearRefusal({ field_type: 'DROPDOWN', read_only: true })).toBe('field_read_only');
  });

  it('every refusal is worded for the signer', () => {
    expect(SIGNER_FIELD_VALUE_COPY['field_clear_not_allowed']).toBeDefined();
    expect(isFieldValueRefusalReason('field_clear_not_allowed')).toBe(true);
  });
});
