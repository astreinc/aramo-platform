// FIELD-PARITY-1 P3 §6 — the new settings (S-1..S-7, S-9), the new types' option and value
// rules, and how values print. Runs under vitest and mobile Jest (globals only).
import {
  NO_TEMPLATE_FIELD_SETTINGS,
  checkboxGroupIssues,
  fieldValueDisplay,
  fieldValueRefusal,
  formatChosenDate,
  formatNumberValue,
  isIsoDate,
  parseFieldSettings,
  parseTemplateFieldSettings,
  senderFilledFieldsEnabled,
  setFieldSettings,
} from '../index.js';

const ok = (settings: object) => ({ ok: true, settings: { ...NO_TEMPLATE_FIELD_SETTINGS, ...settings } });
const refused = (setting: string, reason: string) => ({ ok: false, refusal: expect.objectContaining({ setting, reason }) });

describe('P3 settings — one rule (parseFieldSettings = parseTemplateFieldSettings)', () => {
  it('is one function under two names', () => {
    expect(parseFieldSettings).toBe(parseTemplateFieldSettings);
  });

  it('S-1 label on any type (trimmed, ≤200); a check box keeps its M-A6 reason', () => {
    expect(parseFieldSettings({ label: '  Effective date ' }, 'DATE')).toEqual(ok({ label: 'Effective date' }));
    expect(parseFieldSettings({ label: 'x'.repeat(201) }, 'TEXT')).toEqual(refused('label', 'label_invalid'));
    expect(parseFieldSettings({ label: 3 }, 'CHECKBOX')).toEqual(refused('label', 'checkbox_label_invalid'));
  });

  it('S-1 tooltip (≤500) and S-2 placeholder (≤200, entry types only)', () => {
    expect(parseFieldSettings({ tooltip: 'Use your legal name', placeholder: 'Jane Doe' }, 'TEXT')).toEqual(ok({ tooltip: 'Use your legal name', placeholder: 'Jane Doe' }));
    expect(parseFieldSettings({ tooltip: 'x'.repeat(501) }, 'SIGNATURE')).toEqual(refused('tooltip', 'tooltip_invalid'));
    expect(parseFieldSettings({ placeholder: 'x'.repeat(201) }, 'NUMBER')).toEqual(refused('placeholder', 'placeholder_invalid'));
    expect(parseFieldSettings({ placeholder: 'Sign here' }, 'SIGNATURE')).toEqual(refused('placeholder', 'field_config_not_applicable'));
  });

  it('S-4 / S-5 — sender_filled is dark unless the flag is on; read_only needs sender_filled', () => {
    expect(parseFieldSettings({ sender_filled: true }, 'TEXT')).toEqual(refused('sender_filled', 'sender_filled_not_available'));
    expect(parseFieldSettings({ sender_filled: true }, 'TEXT', { sender_filled_enabled: true })).toEqual(ok({ sender_filled: true }));
    expect(parseFieldSettings({ sender_filled: true, read_only: true }, 'NUMBER', { sender_filled_enabled: true })).toEqual(ok({ sender_filled: true, read_only: true }));
    expect(parseFieldSettings({ read_only: true }, 'TEXT', { sender_filled_enabled: true })).toEqual(refused('read_only', 'read_only_requires_sender_filled'));
    expect(parseFieldSettings({ read_only: 'yes' }, 'TEXT')).toEqual(refused('read_only', 'field_flag_invalid'));
    // false is the default every field has: never "not applicable".
    expect(parseFieldSettings({ read_only: false, sender_filled: false }, 'SIGNATURE')).toEqual(ok({}));
    expect(parseFieldSettings({ sender_filled: true }, 'SIGNATURE', { sender_filled_enabled: true })).toEqual(refused('sender_filled', 'field_config_not_applicable'));
    expect(senderFilledFieldsEnabled({})).toBe(false);
    expect(senderFilledFieldsEnabled({ SIGN_SENDER_FILLED_FIELDS_ENABLED: 'true' })).toBe(false);
    expect(senderFilledFieldsEnabled({ SIGN_SENDER_FILLED_FIELDS_ENABLED: '1' })).toBe(true);
  });

  it('S-6 validation presets per type, with their parameters in options', () => {
    expect(parseFieldSettings({ validation: 'email' }, 'TEXT')).toEqual(ok({ validation: 'email' }));
    expect(parseFieldSettings({ validation: 'email' }, 'MULTILINE_TEXT')).toEqual(refused('validation', 'validation_invalid'));
    expect(parseFieldSettings({ validation: 'max_length' }, 'MULTILINE_TEXT')).toEqual(refused('options', 'validation_params_invalid'));
    expect(parseFieldSettings({ validation: 'max_length', options: { max_length: 500 } }, 'MULTILINE_TEXT')).toEqual(ok({ validation: 'max_length', options: { max_length: 500 } }));
    expect(parseFieldSettings({ options: { max_length: 5 } }, 'TEXT')).toEqual(refused('options', 'validation_params_invalid'));
    expect(parseFieldSettings({ validation: 'number_range', options: { min: 10, max: 1 } }, 'NUMBER')).toEqual(refused('options', 'validation_params_invalid'));
    expect(parseFieldSettings({ validation: 'number_range', options: { min: 0 } }, 'NUMBER')).toEqual(ok({ validation: 'number_range', options: { min: 0 } }));
    expect(parseFieldSettings({ validation: 'date_range', options: { min_date: '2026-02-30' } }, 'DATE')).toEqual(refused('options', 'validation_params_invalid'));
    expect(parseFieldSettings({ validation: 'date_range', options: { min_date: '2026-01-01', max_date: '2026-12-31' } }, 'DATE')).toEqual(
      ok({ validation: 'date_range', options: { min_date: '2026-01-01', max_date: '2026-12-31' } }),
    );
    expect(parseFieldSettings({ validation: 'phone' }, 'SIGNATURE')).toEqual(refused('validation', 'field_config_not_applicable'));
  });

  it('S-7 font_size: a whole number of points 6..36 (absent = auto); S-9 data_name lower_snake', () => {
    expect(parseFieldSettings({ font_size: 9, data_name: 'meeting_date' }, 'DATE')).toEqual(ok({ font_size: 9, data_name: 'meeting_date' }));
    expect(parseFieldSettings({ font_size: 5 }, 'TEXT')).toEqual(refused('font_size', 'font_size_invalid'));
    expect(parseFieldSettings({ font_size: 10.5 }, 'TEXT')).toEqual(refused('font_size', 'font_size_invalid'));
    expect(parseFieldSettings({ font_size: 10 }, 'CHECKBOX')).toEqual(refused('font_size', 'field_config_not_applicable'));
    expect(parseFieldSettings({ data_name: 'Meeting Date' }, 'TEXT')).toEqual(refused('data_name', 'data_name_invalid'));
  });

  it('T-4 DROPDOWN needs 1..50 unique choices (a string is shorthand; label defaults to value)', () => {
    expect(parseFieldSettings({}, 'DROPDOWN')).toEqual(refused('options', 'dropdown_choices_invalid'));
    expect(parseFieldSettings({ options: { choices: [] } }, 'DROPDOWN')).toEqual(refused('options', 'dropdown_choices_invalid'));
    expect(parseFieldSettings({ options: { choices: ['a', 'a'] } }, 'DROPDOWN')).toEqual(refused('options', 'dropdown_choices_invalid'));
    expect(parseFieldSettings({ options: { choices: ['yes', { value: 'no', label: 'No thanks' }] } }, 'DROPDOWN')).toEqual(
      ok({ options: { choices: [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'No thanks' }] } }),
    );
    expect(parseFieldSettings({ options: { choices: ['a'], decimals: 2 } }, 'DROPDOWN')).toEqual(refused('options', 'options_invalid'));
  });

  it('T-6 NUMBER format: money defaults to USD and 2 decimals; currency needs money', () => {
    expect(parseFieldSettings({ options: { format: 'money' } }, 'NUMBER')).toEqual(ok({ options: { format: 'money', currency: 'USD', decimals: 2 } }));
    expect(parseFieldSettings({ options: { format: 'money', currency: 'EUR', decimals: 0 } }, 'NUMBER')).toEqual(ok({ options: { format: 'money', currency: 'EUR', decimals: 0 } }));
    expect(parseFieldSettings({ options: { currency: 'EUR' } }, 'NUMBER')).toEqual(refused('options', 'number_format_invalid'));
    expect(parseFieldSettings({ options: { format: 'money', currency: 'usd' } }, 'NUMBER')).toEqual(refused('options', 'number_format_invalid'));
    expect(parseFieldSettings({ options: { decimals: 7 } }, 'NUMBER')).toEqual(refused('options', 'number_format_invalid'));
    expect(parseFieldSettings({ options: {} }, 'NUMBER')).toEqual(ok({}));
    expect(parseFieldSettings({ options: { choices: ['a'] } }, 'SIGNATURE')).toEqual(refused('options', 'field_config_not_applicable'));
  });

  it('T-5 RADIO is always one option of a SELECT_ONE group (group_key required; no min_selected)', () => {
    expect(parseFieldSettings({ label: 'Yes' }, 'RADIO')).toEqual(refused('group_key', 'radio_group_required'));
    expect(parseFieldSettings({ group_key: 'vote', label: 'Yes' }, 'RADIO')).toEqual(ok({ group_key: 'vote', group_rule: 'SELECT_ONE', label: 'Yes' }));
    expect(parseFieldSettings({ group_key: 'vote', group_rule: 'SELECT_ANY' }, 'RADIO')).toEqual(refused('group_rule', 'radio_group_invalid'));
    expect(parseFieldSettings({ group_key: 'vote', min_selected: 1 }, 'RADIO')).toEqual(refused('min_selected', 'field_config_not_applicable'));
  });

  it('a group is one type and one read-only / sender-filled setting', () => {
    const b = (k: string, over: object = {}) => ({ field_key: k, signer_role: 'signer', required: true, group_key: 'g', group_rule: 'SELECT_ONE', min_selected: null, field_type: 'RADIO', ...over });
    expect(checkboxGroupIssues([b('a'), b('b')])).toEqual([]);
    expect(checkboxGroupIssues([b('a'), b('b', { field_type: 'CHECKBOX' })])).toEqual([expect.objectContaining({ reason: 'checkbox_group_inconsistent' })]);
    expect(checkboxGroupIssues([b('a'), b('b', { sender_filled: true })])).toEqual([expect.objectContaining({ reason: 'checkbox_group_inconsistent' })]);
  });

  it('setFieldSettings keeps only what is set (NULL and false left out)', () => {
    expect(setFieldSettings(NO_TEMPLATE_FIELD_SETTINGS)).toEqual({});
    expect(setFieldSettings({ ...NO_TEMPLATE_FIELD_SETTINGS, label: 'A', read_only: true, sender_filled: true, options: { min: 1 } })).toEqual({
      label: 'A',
      read_only: true,
      sender_filled: true,
      options: { min: 1 },
    });
  });
});

describe('P3 values — fieldValueRefusal', () => {
  it('boolean types (CHECKBOX, RADIO, ACKNOWLEDGEMENT) hold true / false', () => {
    for (const t of ['CHECKBOX', 'RADIO', 'ACKNOWLEDGEMENT']) {
      expect(fieldValueRefusal({ field_type: t }, 'true')).toBeNull();
      expect(fieldValueRefusal({ field_type: t }, 'yes')).toBe('checkbox_value_invalid');
    }
  });

  it('DATE is a real YYYY-MM-DD within its date_range', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(fieldValueRefusal({ field_type: 'DATE' }, '2026-13-01')).toBe('date_value_invalid');
    expect(fieldValueRefusal({ field_type: 'DATE' }, '')).toBe('date_value_invalid');
    const ranged = { field_type: 'DATE', validation: 'date_range', options: { min_date: '2026-01-01', max_date: '2026-12-31' } };
    expect(fieldValueRefusal(ranged, '2026-06-01')).toBeNull();
    expect(fieldValueRefusal(ranged, '2027-01-01')).toBe('validation_date_range_failed');
  });

  it('NUMBER is a decimal with at most its decimals, within its number_range', () => {
    expect(fieldValueRefusal({ field_type: 'NUMBER' }, '12.5')).toBeNull();
    expect(fieldValueRefusal({ field_type: 'NUMBER' }, '1e5')).toBe('number_value_invalid');
    expect(fieldValueRefusal({ field_type: 'NUMBER' }, '1,000')).toBe('number_value_invalid');
    expect(fieldValueRefusal({ field_type: 'NUMBER', options: { decimals: 0 } }, '3.1')).toBe('number_decimals_exceeded');
    expect(fieldValueRefusal({ field_type: 'NUMBER', validation: 'number_range', options: { min: 1, max: 10 } }, '11')).toBe('validation_number_range_failed');
  });

  it('DROPDOWN holds one choice value', () => {
    const f = { field_type: 'DROPDOWN', options: { choices: [{ value: 'a', label: 'A' }] } };
    expect(fieldValueRefusal(f, 'a')).toBeNull();
    expect(fieldValueRefusal(f, 'A')).toBe('dropdown_value_invalid');
  });

  it('TEXT presets (email, phone, us_zip, max_length); empty text is allowed as always', () => {
    expect(fieldValueRefusal({ field_type: 'TEXT' }, 'anything at all')).toBeNull();
    expect(fieldValueRefusal({ field_type: 'TEXT', validation: 'email' }, '')).toBeNull();
    expect(fieldValueRefusal({ field_type: 'TEXT', validation: 'email' }, 'a@b')).toBe('validation_email_failed');
    expect(fieldValueRefusal({ field_type: 'TEXT', validation: 'phone' }, '+1 (555) 010-2000')).toBeNull();
    expect(fieldValueRefusal({ field_type: 'TEXT', validation: 'phone' }, '12ab')).toBe('validation_phone_failed');
    expect(fieldValueRefusal({ field_type: 'TEXT', validation: 'us_zip' }, '02139-1234')).toBeNull();
    expect(fieldValueRefusal({ field_type: 'TEXT', validation: 'us_zip' }, '0213')).toBe('validation_us_zip_failed');
    expect(fieldValueRefusal({ field_type: 'MULTILINE_TEXT', validation: 'max_length', options: { max_length: 3 } }, 'abcd')).toBe('validation_max_length_failed');
    expect(fieldValueRefusal({ field_type: 'MULTILINE_TEXT' }, 'x'.repeat(4001))).toBe('multiline_text_too_long');
  });

  it('a type with its own rule elsewhere is left alone', () => {
    expect(fieldValueRefusal({ field_type: 'SIGNATURE' }, 'data:…')).toBeNull();
    expect(fieldValueRefusal({ field_type: 'EMAIL' }, 'not checked here')).toBeNull();
  });
});

describe('P3 values — how they print', () => {
  it('DATE in the envelope date format (default MM/DD/YYYY)', () => {
    expect(formatChosenDate('2026-03-04', null)).toBe('03/04/2026');
    expect(formatChosenDate('2026-03-04', 'DD/MM/YYYY')).toBe('04/03/2026');
    expect(formatChosenDate('2026-03-04', 'YYYY-MM-DD')).toBe('2026-03-04');
    expect(formatChosenDate('soon', null)).toBe('soon');
  });

  it('NUMBER grouped, fixed decimals, money with its currency', () => {
    expect(formatNumberValue('1234567.5', null)).toBe('1,234,567.5');
    expect(formatNumberValue('1234.5', { decimals: 2 })).toBe('1,234.50');
    expect(formatNumberValue('-1234.5', { format: 'money', currency: 'USD', decimals: 2 })).toBe('-$1,234.50');
    expect(formatNumberValue('99', { format: 'money', currency: 'CHF', decimals: 2 })).toBe('CHF 99.00');
    expect(formatNumberValue('007', null)).toBe('7');
  });

  it('fieldValueDisplay — DATE, NUMBER, DROPDOWN label; anything else unchanged', () => {
    expect(fieldValueDisplay({ field_type: 'DATE' }, '2026-03-04', { date_format: 'DD/MM/YYYY' })).toBe('04/03/2026');
    expect(fieldValueDisplay({ field_type: 'NUMBER', options: { format: 'money', currency: 'USD', decimals: 2 } }, '5')).toBe('$5.00');
    expect(fieldValueDisplay({ field_type: 'DROPDOWN', options: { choices: [{ value: 'ny', label: 'New York' }] } }, 'ny')).toBe('New York');
    expect(fieldValueDisplay({ field_type: 'MULTILINE_TEXT' }, 'a\nb')).toBe('a\nb');
  });
});
