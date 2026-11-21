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
