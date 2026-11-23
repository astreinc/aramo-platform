// Runs under vitest and mobile Jest (globals only).
// FIELD-PARITY-2 §4.2 B-4, §5 test 1 — the one visibility rule: a truth table per trigger kind,
// chains, and the required counts it feeds (signerFieldUnits / evaluateSignerFieldRules).
import { evaluateSignerFieldRules, hiddenFilledFields, isFieldShown, shownFields, signerFieldUnits, type FieldRuleRow } from '../index.js';

interface F {
  readonly field_key: string;
  readonly field_type: string;
  readonly required: boolean;
  readonly condition?: unknown;
  readonly group_key?: string | null;
  value: string | null;
}
const f = (field_key: string, field_type: string, condition: unknown = null, required = false): F => ({ field_key, field_type, required, condition, value: null });
const keysShown = (fields: readonly F[]) => [...shownFields(fields, (x) => x.value)].map((x) => x.field_key);

describe('FIELD-PARITY-2 B-4 — shownFields truth table', () => {
  it.each([
    ['checked', 'CHECKBOX', 'true', true],
    ['checked', 'CHECKBOX', 'false', false],
    ['checked', 'CHECKBOX', null, false],
    ['unchecked', 'CHECKBOX', 'true', false],
    ['unchecked', 'CHECKBOX', 'false', true],
    ['unchecked', 'CHECKBOX', null, true],
    ['checked', 'ACKNOWLEDGEMENT', 'true', true],
    ['unchecked', 'ACKNOWLEDGEMENT', null, true],
    ['chosen', 'RADIO', 'true', true],
    ['chosen', 'RADIO', 'false', false],
    ['chosen', 'RADIO', null, false],
  ] as const)('%s on a %s holding %s → shown %s', (when, type, value, shown) => {
    const trigger = { ...f('t', type), value };
    const dep = f('d', 'TEXT', { trigger_key: 't', when });
    expect(isFieldShown(dep, [trigger, dep], (x) => x.value)).toBe(shown);
  });

  it('one_of on a DROPDOWN: shown only for a listed value', () => {
    const drop = f('plan', 'DROPDOWN');
    const dep = f('d', 'TEXT', { trigger_key: 'plan', when: 'one_of', values: ['b', 'c'] });
    for (const [value, shown] of [['b', true], ['c', true], ['a', false], [null, false]] as const) {
      drop.value = value;
      expect(isFieldShown(dep, [drop, dep], (x) => x.value)).toBe(shown);
    }
  });

  it('chains: a hidden trigger hides its dependents, three deep', () => {
    const a = f('a', 'CHECKBOX');
    const b = f('b', 'CHECKBOX', { trigger_key: 'a', when: 'checked' });
    const c = f('c', 'CHECKBOX', { trigger_key: 'b', when: 'checked' });
    const d = f('d', 'TEXT', { trigger_key: 'c', when: 'unchecked' });
    const all = [a, b, c, d];
    expect(keysShown(all)).toEqual(['a']);
    a.value = 'true';
    expect(keysShown(all)).toEqual(['a', 'b']);
    b.value = 'true';
    expect(keysShown(all)).toEqual(['a', 'b', 'c', 'd']);
    c.value = 'true';
    expect(keysShown(all)).toEqual(['a', 'b', 'c']);
    // Untick the root: everything below hides, whatever the stale values say.
    a.value = 'false';
    expect(keysShown(all)).toEqual(['a']);
  });

  it('fail-open: a trigger not in the list, a loop, or a broken shape shows the field', () => {
    expect(keysShown([f('d', 'TEXT', { trigger_key: 'elsewhere', when: 'checked' })])).toEqual(['d']);
    expect(keysShown([f('x', 'CHECKBOX', { trigger_key: 'y', when: 'checked' }), f('y', 'CHECKBOX', { trigger_key: 'x', when: 'checked' })])).toEqual(['x', 'y']);
    expect(keysShown([f('d', 'TEXT', { trigger_key: 't' })])).toEqual(['d']);
  });

  it('hiddenFilledFields: the hidden fields still holding a value (what the server clears)', () => {
    const a = { ...f('a', 'CHECKBOX'), value: 'false' };
    const b = { ...f('b', 'CHECKBOX', { trigger_key: 'a', when: 'checked' }), value: 'true' };
    const c = { ...f('c', 'TEXT', { trigger_key: 'b', when: 'checked' }), value: 'typed' };
    const e = f('e', 'TEXT', { trigger_key: 'a', when: 'checked' });
    expect(hiddenFilledFields([a, b, c, e], (x) => x.value, (x) => x.value !== null).map((x) => x.field_key)).toEqual(['b', 'c']);
  });
});

describe('FIELD-PARITY-2 B-4 — a hidden field is never required and never counted', () => {
  it('signerFieldUnits counts only shown fields (progress "N of M")', () => {
    const box = f('agree', 'CHECKBOX');
    const dep = f('d', 'TEXT', { trigger_key: 'agree', when: 'checked' }, true);
    const sig = f('sig', 'SIGNATURE', null, true);
    const units = () => signerFieldUnits([sig, box, dep], { filled: (x) => x.value !== null, checked: (x) => x.value === 'true', value: (x) => x.value });
    expect(units().length).toBe(1);
    box.value = 'true';
    expect(units().length).toBe(2);
    // Without `value`, a check-box trigger still reads its checked state.
    expect(signerFieldUnits([sig, box, dep], { filled: (x) => x.value !== null, checked: (x) => x.value === 'true' }).length).toBe(2);
  });

  it('a hidden radio option leaves its group; a hidden required group is no unit', () => {
    const box = f('agree', 'CHECKBOX');
    const r1 = { ...f('r1', 'RADIO', { trigger_key: 'agree', when: 'checked' }, true), group_key: 'g' };
    const r2 = { ...f('r2', 'RADIO', { trigger_key: 'agree', when: 'checked' }, true), group_key: 'g' };
    expect(signerFieldUnits([box, r1, r2], { filled: (x) => x.value !== null, checked: (x) => x.value === 'true', value: (x) => x.value })).toEqual([]);
  });

  it('evaluateSignerFieldRules (the server completion check) skips hidden required fields', () => {
    const row = (o: Partial<FieldRuleRow> & Pick<FieldRuleRow, 'id' | 'field_type'>): FieldRuleRow => ({ required: false, value: null, filled_at: null, ...o });
    const rows = [
      row({ id: 's', field_type: 'SIGNATURE', required: true, value: 'data:', filled_at: new Date() }),
      row({ id: 'b', field_type: 'CHECKBOX', field_key: 'agree', value: 'false', filled_at: new Date() }),
      row({ id: 'd', field_type: 'TEXT', required: true, condition: { trigger_key: 'agree', when: 'checked' } }),
    ];
    expect(evaluateSignerFieldRules(rows)).toBeNull();
    rows[1] = { ...rows[1]!, value: 'true' };
    expect(evaluateSignerFieldRules(rows)).toEqual({ reason: 'required_field_unfilled', field_id: 'd' });
  });
});
