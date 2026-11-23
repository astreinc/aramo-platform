// Runs under vitest and mobile Jest (globals only).
import {
  CONDITION_VALUES_MAX,
  FIELD_KEY_MAX,
  NO_TEMPLATE_FIELD_SETTINGS,
  duplicateFieldKeys,
  isFieldKey,
  parseFieldCondition,
  parseFieldSettings,
  setFieldSettings,
} from '../index.js';

// FIELD-PARITY-2 (Aramo-Sign-Field-Placement-Conditional-Fields-Directive-v1_0-LOCKED) §4.2 B-1 /
// B-2 — the field key and the condition's shape (the cross-field rule: field-condition-issues.test.ts).

describe('FIELD-PARITY-2 B-1 — field keys', () => {
  it('a key is 1 to FIELD_KEY_MAX characters and not blank', () => {
    expect(isFieldKey('k')).toBe(true);
    expect(isFieldKey('x'.repeat(FIELD_KEY_MAX))).toBe(true);
    for (const bad of ['', '   ', 'x'.repeat(FIELD_KEY_MAX + 1), 7, null, undefined]) expect(isFieldKey(bad)).toBe(false);
  });

  it('duplicateFieldKeys lists the keys used twice (NULL keys never)', () => {
    expect(duplicateFieldKeys([{ field_key: 'a' }, { field_key: null }, { field_key: 'b' }, { field_key: null }, { field_key: 'a' }, {}])).toEqual(['a']);
    expect(duplicateFieldKeys([{ field_key: 'a' }, { field_key: 'b' }])).toEqual([]);
  });
});

describe('FIELD-PARITY-2 B-2 — the condition shape', () => {
  it('accepts each rule and normalizes nothing else', () => {
    expect(parseFieldCondition(null)).toEqual({ ok: true, condition: null });
    expect(parseFieldCondition(undefined)).toEqual({ ok: true, condition: null });
    for (const when of ['checked', 'unchecked', 'chosen'] as const) {
      expect(parseFieldCondition({ trigger_key: 't', when })).toEqual({ ok: true, condition: { trigger_key: 't', when } });
    }
    expect(parseFieldCondition({ trigger_key: 't', when: 'one_of', values: ['a', 'b'] })).toEqual({ ok: true, condition: { trigger_key: 't', when: 'one_of', values: ['a', 'b'] } });
  });

  it('refuses every broken shape', () => {
    const bad: unknown[] = [
      'checked',
      [],
      { when: 'checked' },
      { trigger_key: '', when: 'checked' },
      { trigger_key: 'x'.repeat(FIELD_KEY_MAX + 1), when: 'checked' },
      { trigger_key: 't' },
      { trigger_key: 't', when: 'is' },
      { trigger_key: 't', when: 'checked', values: ['a'] },
      { trigger_key: 't', when: 'one_of' },
      { trigger_key: 't', when: 'one_of', values: [] },
      { trigger_key: 't', when: 'one_of', values: Array.from({ length: CONDITION_VALUES_MAX + 1 }, (_, i) => `v${i}`) },
      { trigger_key: 't', when: 'one_of', values: ['a', 'a'] },
      { trigger_key: 't', when: 'one_of', values: [' '] },
      { trigger_key: 't', when: 'one_of', values: [1] },
      { trigger_key: 't', when: 'checked', and: { trigger_key: 'u', when: 'checked' } },
    ];
    for (const raw of bad) expect(parseFieldCondition(raw).ok, JSON.stringify(raw)).toBe(false);
  });

  it('is a setting of the one settings rule: condition_invalid, never on PAYMENT or a sender-filled field', () => {
    expect(parseFieldSettings({ condition: { trigger_key: 'agree', when: 'checked' } }, 'SIGNATURE')).toEqual({
      ok: true,
      settings: { ...NO_TEMPLATE_FIELD_SETTINGS, condition: { trigger_key: 'agree', when: 'checked' } },
    });
    expect(parseFieldSettings({ condition: { trigger_key: 'agree' } }, 'TEXT')).toMatchObject({ ok: false, refusal: { setting: 'condition', reason: 'condition_invalid' } });
    expect(parseFieldSettings({ condition: { trigger_key: 'agree', when: 'checked' } }, 'PAYMENT')).toMatchObject({ ok: false, refusal: { setting: 'condition', reason: 'field_config_not_applicable' } });
    expect(parseFieldSettings({ sender_filled: true, condition: { trigger_key: 'agree', when: 'checked' } }, 'TEXT', { sender_filled_enabled: true })).toMatchObject({
      ok: false,
      refusal: { setting: 'condition', reason: 'condition_invalid' },
    });
    expect(setFieldSettings({ ...NO_TEMPLATE_FIELD_SETTINGS, condition: { trigger_key: 'a', when: 'checked' } })).toEqual({ condition: { trigger_key: 'a', when: 'checked' } });
  });
});
