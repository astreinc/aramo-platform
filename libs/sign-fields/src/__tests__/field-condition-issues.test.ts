// Runs under vitest and mobile Jest (globals only).
import { CONDITION_DEPTH_MAX, fieldConditionIssues, type ConditionalFieldLike } from '../index.js';

// FIELD-PARITY-2 §4.2 B-3, §5 test 1 — the one cross-field rule: every refusal, chains and cycles.

const f = (field_key: string | null, field_type: string, extra: Partial<ConditionalFieldLike> = {}): ConditionalFieldLike => ({ field_key, field_type, signer: 's1', ...extra });
const sig = f('sig', 'SIGNATURE');
const box = f('agree', 'CHECKBOX');
const reasons = (fields: readonly ConditionalFieldLike[], opts = {}) => fieldConditionIssues(fields, opts).map((i) => [i.index, i.reason]);

describe('FIELD-PARITY-2 B-3 — fieldConditionIssues', () => {
  it('accepts every rule on its trigger type, a shared trigger, and no conditions at all', () => {
    const drop = f('plan', 'DROPDOWN', { options: { choices: [{ value: 'a' }, { value: 'b' }] } });
    const fields = [
      sig,
      box,
      f('ack', 'ACKNOWLEDGEMENT'),
      f('yes', 'RADIO'),
      drop,
      f('t1', 'TEXT', { condition: { trigger_key: 'agree', when: 'checked' } }),
      f('t2', 'TEXT', { condition: { trigger_key: 'agree', when: 'checked' } }),
      f('t3', 'TEXT', { condition: { trigger_key: 'ack', when: 'unchecked' } }),
      f('t4', 'DATE', { condition: { trigger_key: 'yes', when: 'chosen' } }),
      f('t5', 'NUMBER', { condition: { trigger_key: 'plan', when: 'one_of', values: ['b'] } }),
      f(null, 'TEXT'),
    ];
    expect(fieldConditionIssues(fields)).toEqual([]);
    expect(fieldConditionIssues([sig, box])).toEqual([]);
  });

  it('refuses each problem with its named reason', () => {
    const drop = f('plan', 'DROPDOWN', { options: { choices: [{ value: 'a' }] } });
    expect(reasons([sig, f('t', 'TEXT', { condition: { trigger_key: 'nope', when: 'checked' } })])).toEqual([[1, 'condition_trigger_unknown']]);
    expect(reasons([sig, f('t', 'TEXT'), f('u', 'TEXT', { condition: { trigger_key: 't', when: 'checked' } })])).toEqual([[2, 'condition_trigger_type_invalid']]);
    expect(reasons([sig, box, f('u', 'TEXT', { condition: { trigger_key: 'agree', when: 'chosen' } })])).toEqual([[2, 'condition_trigger_type_invalid']]);
    expect(reasons([sig, drop, f('u', 'TEXT', { condition: { trigger_key: 'plan', when: 'checked' } })])).toEqual([[2, 'condition_trigger_type_invalid']]);
    expect(reasons([sig, box, f('u', 'TEXT', { signer: 's2', condition: { trigger_key: 'agree', when: 'checked' } })])).toEqual([[2, 'condition_cross_signer']]);
    expect(reasons([sig, box, f('u', 'TEXT', { signer: null, condition: { trigger_key: 'agree', when: 'checked' } })])).toEqual([[2, 'condition_cross_signer']]);
    expect(reasons([sig, drop, f('u', 'TEXT', { condition: { trigger_key: 'plan', when: 'one_of', values: ['a', 'z'] } })])).toEqual([[2, 'condition_values_invalid']]);
    expect(reasons([sig, f('u', 'TEXT', { condition: { trigger_key: 'agree' } as never })])).toEqual([[1, 'condition_invalid']]);
    expect(reasons([sig, box, f('u', 'TEXT', { sender_filled: true, condition: { trigger_key: 'agree', when: 'checked' } })])).toEqual([[2, 'condition_invalid']]);
    expect(reasons([sig, box, f('agree', 'TEXT')])).toEqual([[2, 'field_key_duplicate']]);
  });

  it('refuses a cycle (a self-trigger, a loop of two, a loop of three)', () => {
    expect(reasons([sig, f('a', 'CHECKBOX', { condition: { trigger_key: 'a', when: 'checked' } })])).toEqual([[1, 'condition_cycle']]);
    expect(
      reasons([sig, f('a', 'CHECKBOX', { condition: { trigger_key: 'b', when: 'checked' } }), f('b', 'CHECKBOX', { condition: { trigger_key: 'a', when: 'checked' } })]),
    ).toEqual([
      [1, 'condition_cycle'],
      [2, 'condition_cycle'],
    ]);
    const three = [
      sig,
      f('a', 'CHECKBOX', { condition: { trigger_key: 'c', when: 'checked' } }),
      f('b', 'CHECKBOX', { condition: { trigger_key: 'a', when: 'checked' } }),
      f('c', 'CHECKBOX', { condition: { trigger_key: 'b', when: 'unchecked' } }),
    ];
    expect(reasons(three).map(([, r]) => r)).toEqual(['condition_cycle', 'condition_cycle', 'condition_cycle']);
  });

  it(`allows a chain ${CONDITION_DEPTH_MAX} deep and refuses one deeper`, () => {
    const chain = (n: number): ConditionalFieldLike[] => [
      sig,
      f('c0', 'CHECKBOX'),
      ...Array.from({ length: n }, (_, i) => f(`c${i + 1}`, 'CHECKBOX', { condition: { trigger_key: `c${i}`, when: 'checked' } })),
    ];
    expect(fieldConditionIssues(chain(CONDITION_DEPTH_MAX))).toEqual([]);
    expect(reasons(chain(CONDITION_DEPTH_MAX + 1))).toEqual([[CONDITION_DEPTH_MAX + 2, 'condition_depth_exceeded']]);
  });

  it('C-6 — a conditional SIGNATURE needs an unconditional one for the same signer (unless the list is partial)', () => {
    const condSig = f('sig2', 'SIGNATURE', { condition: { trigger_key: 'agree', when: 'checked' } });
    expect(fieldConditionIssues([box, condSig, f('sig', 'SIGNATURE')])).toEqual([]);
    expect(reasons([box, condSig])).toEqual([[1, 'condition_no_unconditional_signature']]);
    expect(reasons([box, condSig, f('other', 'SIGNATURE', { signer: 's2' })])).toEqual([[1, 'condition_no_unconditional_signature']]);
    expect(fieldConditionIssues([box, condSig], { requireUnconditionalSignature: false })).toEqual([]);
  });

  it('a field with no condition is never refused for its key being absent; only keyed fields can be triggers', () => {
    expect(reasons([sig, f(null, 'CHECKBOX'), f(null, 'CHECKBOX'), f('t', 'TEXT', { condition: { trigger_key: 'null', when: 'checked' } })])).toEqual([[3, 'condition_trigger_unknown']]);
  });
});
