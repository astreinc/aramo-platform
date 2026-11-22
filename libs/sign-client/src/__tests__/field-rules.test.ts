// Client Rule Consolidation C2-5 — runs under vitest and mobile Jest (globals only).
// Audit row 38: the required-fields-before-Finish rule; one copy for server and clients.
import {
  PROFILE_TEXT_FIELD_TYPES,
  PROFILE_TEXT_MAX,
  evaluateSignerFieldRules,
  isPaymentField,
  isProfileTextField,
  isServerFilledName,
  profileTextValueRefusal,
  signerFieldUnits,
  type FieldRuleRow,
  type FieldRuleViolation,
} from '../index.js';

const at = new Date('2026-10-28T00:00:00Z');
const f = (id: string, o: Partial<FieldRuleRow> = {}): FieldRuleRow => ({ id, field_type: 'CHECKBOX', required: true, value: null, filled_at: null, ...o });
const on = { value: 'true', filled_at: at };
const off = { value: 'false', filled_at: at };
const one = { group_key: 'g', group_rule: 'SELECT_ONE' };
const any = { group_key: 'g', group_rule: 'SELECT_ANY' };
const two = { ...any, min_selected: 2 };

describe('evaluateSignerFieldRules (M-A6 §2.3)', () => {
  const cases: Array<[string, FieldRuleRow[], FieldRuleViolation | null]> = [
    ['required check box unchecked', [f('a')], { reason: 'checkbox_required_unchecked', field_id: 'a' }],
    ['required check box false', [f('a', off)], { reason: 'checkbox_required_unchecked', field_id: 'a' }],
    ['required check box checked', [f('a', on)], null],
    ['optional check box false', [f('a', { required: false, ...off })], null],
    ['acknowledgement false', [f('a', { field_type: 'ACKNOWLEDGEMENT', ...off })], { reason: 'checkbox_required_unchecked', field_id: 'a' }],
    ['required text unfilled', [f('a', { field_type: 'TEXT' })], { reason: 'required_field_unfilled', field_id: 'a' }],
    ['required text filled', [f('a', { field_type: 'TEXT', value: 'x', filled_at: at })], null],
    ['profile name is server-filled', [f('a', { field_type: 'SIGNER_NAME', name_mode: 'SIGNER_PROFILE' })], null],
    ['entered name unfilled', [f('a', { field_type: 'SIGNER_NAME', name_mode: 'SIGNER_ENTERED' })], { reason: 'required_field_unfilled', field_id: 'a' }],
    ['legacy name unfilled', [f('a', { field_type: 'SIGNER_NAME', name_mode: null })], { reason: 'required_field_unfilled', field_id: 'a' }],
    ['payment unpaid (even optional)', [f('a', { field_type: 'PAYMENT', required: false })], { reason: 'payment_required', field_id: 'a' }],
    ['payment paid', [f('a', { field_type: 'PAYMENT', value: 'paid', filled_at: at })], null],
    ['SELECT_ONE required, none checked', [f('a', one), f('b', one)], { reason: 'checkbox_group_select_one', group_key: 'g' }],
    ['SELECT_ONE one checked', [f('a', { ...one, ...on }), f('b', { ...one, ...off })], null],
    ['SELECT_ONE two checked', [f('a', { ...one, ...on }), f('b', { ...one, ...on })], { reason: 'checkbox_group_select_one', group_key: 'g' }],
    ['SELECT_ONE optional, two checked', [f('a', { ...one, required: false, ...on }), f('b', { ...one, required: false, ...on })], { reason: 'checkbox_group_select_one', group_key: 'g' }],
    ['SELECT_ONE optional, none checked', [f('a', { ...one, required: false }), f('b', { ...one, required: false })], null],
    ['SELECT_ANY one checked', [f('a', { ...any, ...on }), f('b', { ...any, ...off })], null],
    ['SELECT_ANY none checked', [f('a', { ...any, ...off }), f('b', any)], { reason: 'checkbox_group_min_selected', group_key: 'g' }],
    ['min 2, one checked', [f('a', { ...two, ...on }), f('b', { ...two, ...off }), f('c', two)], { reason: 'checkbox_group_min_selected', group_key: 'g' }],
    ['min 2, two checked', [f('a', { ...two, ...on }), f('b', { ...two, ...on }), f('c', two)], null],
    ['min 2 optional, none checked', [f('a', { ...two, required: false }), f('b', { ...two, required: false })], null],
    // FIELD-PARITY-1 P3 T-5 — a radio group is SELECT_ONE (its own reason).
    ['radio required, none chosen', [f('a', { field_type: 'RADIO', ...one }), f('b', { field_type: 'RADIO', ...one })], { reason: 'radio_group_select_one', group_key: 'g' }],
    ['radio one chosen', [f('a', { field_type: 'RADIO', ...one, ...on }), f('b', { field_type: 'RADIO', ...one, ...off })], null],
    ['radio optional, two chosen', [f('a', { field_type: 'RADIO', ...one, required: false, ...on }), f('b', { field_type: 'RADIO', ...one, required: false, ...on })], { reason: 'radio_group_select_one', group_key: 'g' }],
    ['radio optional, none chosen', [f('a', { field_type: 'RADIO', ...one, required: false }), f('b', { field_type: 'RADIO', ...one, required: false })], null],
    // T-3 / T-4 / T-6 / T-7 — required new types are filled like text.
    ['required date unfilled', [f('a', { field_type: 'DATE' })], { reason: 'required_field_unfilled', field_id: 'a' }],
    ['required dropdown filled', [f('a', { field_type: 'DROPDOWN', value: 'x', filled_at: at })], null],
    // S-4 / S-5 — a sender-filled (read-only) field is never the signer's unit.
    ['sender-filled required text', [f('a', { field_type: 'TEXT', sender_filled: true })], null],
    ['sender-filled read-only number', [f('a', { field_type: 'NUMBER', sender_filled: true, read_only: true })], null],
  ];

  it.each(cases)('%s', (_name, fields, expected) => {
    expect(evaluateSignerFieldRules(fields)).toEqual(expected);
  });
});

describe('field classifiers', () => {
  it.each([
    ['SIGNER_NAME', 'SIGNER_PROFILE', true],
    ['SIGNER_NAME', 'SIGNER_ENTERED', false],
    ['SIGNER_NAME', null, false],
    ['TEXT', 'SIGNER_PROFILE', false],
  ])('isServerFilledName(%s, %s) = %s', (field_type, name_mode, expected) => {
    expect(isServerFilledName({ field_type, name_mode })).toBe(expected);
  });

  it.each([...PROFILE_TEXT_FIELD_TYPES.map((t) => [t, true] as const), ['TEXT', false] as const, ['SIGNATURE', false] as const])('isProfileTextField(%s) = %s', (field_type, expected) => {
    expect(isProfileTextField({ field_type })).toBe(expected);
  });

  it.each([['PAYMENT', true], ['TEXT', false]])('isPaymentField(%s) = %s', (field_type, expected) => {
    expect(isPaymentField({ field_type })).toBe(expected);
  });
});

describe('profileTextValueRefusal (M-A12 W1-C.4)', () => {
  it.each([
    ['FIRST_NAME', 'Alex', null],
    ['FIRST_NAME', 'x'.repeat(PROFILE_TEXT_MAX), null],
    ['FIRST_NAME', 'x'.repeat(PROFILE_TEXT_MAX + 1), 'profile_field_value_invalid'],
    ['EMAIL', 'alex@example.com', null],
    ['EMAIL', '', null],
    ['EMAIL', 'not an email', 'email_field_value_invalid'],
    // The 200-character cap applies first, so an over-long address is refused by it.
    ['EMAIL', `${'a'.repeat(250)}@b.co`, 'profile_field_value_invalid'],
    ['TEXT', 'x'.repeat(500), null],
  ])('%s %p → %s', (field_type, value, expected) => {
    expect(profileTextValueRefusal(field_type, value)).toBe(expected);
  });
});

// C3 (row 38) — the units both signer screens count (progress, Finish) and the server's check uses.
describe('signerFieldUnits (row 38: one rule for web, mobile and the server)', () => {
  interface V {
    id: string;
    field_type: string;
    required: boolean;
    group_key?: string | null;
    group_rule?: string | null;
    min_selected?: number | null;
    name_mode?: string | null;
    server_filled?: boolean;
    v?: string;
  }
  const state = { filled: (x: V) => x.v !== undefined, checked: (x: V) => x.v === 'true' };
  const u = (fields: V[]) => signerFieldUnits(fields, state).map((x) => [x.fields.map((y) => y.id).join('+'), x.done, x.reason]);
  it.each<[string, V[], unknown[]]>([
    ['required text', [{ id: 'a', field_type: 'TEXT', required: true }], [['a', false, 'required_field_unfilled']]],
    ['optional text is not a unit', [{ id: 'a', field_type: 'TEXT', required: false }], []],
    ['server-filled flag', [{ id: 'a', field_type: 'TEXT', required: true, server_filled: true }], []],
    ['profile name', [{ id: 'a', field_type: 'SIGNER_NAME', required: true, name_mode: 'SIGNER_PROFILE' }], []],
    ['required box checked', [{ id: 'a', field_type: 'CHECKBOX', required: true, v: 'true' }], [['a', true, 'checkbox_required_unchecked']]],
    ['required box false', [{ id: 'a', field_type: 'CHECKBOX', required: true, v: 'false' }], [['a', false, 'checkbox_required_unchecked']]],
    ['payment, even optional', [{ id: 'a', field_type: 'PAYMENT', required: false }], [['a', false, 'payment_required']]],
    ['payment marked server_filled is still the signer’s to pay', [{ id: 'a', field_type: 'PAYMENT', required: true, server_filled: true }], [['a', false, 'payment_required']]],
    [
      'a group counts once',
      [
        { id: 'a', field_type: 'CHECKBOX', required: true, group_key: 'g', group_rule: 'SELECT_ANY', min_selected: 2, v: 'true' },
        { id: 'b', field_type: 'CHECKBOX', required: false, group_key: 'g', group_rule: 'SELECT_ANY' },
      ],
      [['a+b', false, 'checkbox_group_min_selected']],
    ],
    [
      'an optional select-one with two checked',
      [
        { id: 'a', field_type: 'CHECKBOX', required: false, group_key: 'g', group_rule: 'SELECT_ONE', v: 'true' },
        { id: 'b', field_type: 'CHECKBOX', required: false, group_key: 'g', group_rule: 'SELECT_ONE', v: 'true' },
      ],
      [['a+b', false, 'checkbox_group_select_one']],
    ],
    ['an empty group key is no group', [{ id: 'a', field_type: 'CHECKBOX', required: true, group_key: '', v: 'true' }], [['a', true, 'checkbox_required_unchecked']]],
  ])('%s', (_n, fields, units) => {
    expect(u(fields)).toEqual(units);
  });
});
