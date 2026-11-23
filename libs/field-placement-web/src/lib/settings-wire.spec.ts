import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, defaultSettingsFor, editableSettingsOf, freeGroupKey, type PlacedField, type PlacementSettings } from './model';
import { applySettings, groupSize } from './settings';
import { cleanChoices, conditionIssues, nextRadioLabel, optionsToWire, radioOptionBelow, settingsFromWire, settingsIssue, settingsToWire } from './settings-wire';

// FIELD-PARITY-1 P3 §6.2 — the editor settings ↔ wire members for every setting and type, the ONE
// settings rule run on the editor's settings, and the radio group rules (T-5).

const S = (over: Partial<PlacementSettings> = {}): PlacementSettings => ({ ...DEFAULT_SETTINGS, ...over });
const field = (id: string, over: Partial<PlacedField> = {}): PlacedField => ({
  id,
  type: 'RADIO',
  docId: 'd1',
  page: 0,
  x: 100,
  y: 500,
  width: 18,
  height: 18,
  required: false,
  assignee: 's1',
  binding: null,
  settings: S({ groupKey: 'radio_1', groupRule: 'SELECT_ONE', label: 'Option 1' }),
  ...over,
});

describe('settings shown per type (fieldSettingsOf ∩ host capabilities)', () => {
  const ALL = { settings: ['label', 'tooltip', 'placeholder', 'read_only', 'sender_filled', 'validation', 'font_size', 'data_name', 'options', 'group_key', 'group_rule', 'min_selected', 'name_mode'] as const };
  it('each new type shows exactly its catalog settings', () => {
    expect(editableSettingsOf('DROPDOWN', ALL)).toEqual(['label', 'tooltip', 'data_name', 'placeholder', 'read_only', 'sender_filled', 'font_size', 'options']);
    expect(editableSettingsOf('RADIO', ALL)).toEqual(['label', 'group_key', 'group_rule', 'tooltip', 'data_name', 'read_only', 'sender_filled']);
    expect(editableSettingsOf('NUMBER', ALL)).toContain('validation');
    expect(editableSettingsOf('ACKNOWLEDGEMENT', ALL)).toEqual(['label', 'tooltip', 'data_name']);
    expect(editableSettingsOf('PAYMENT', ALL)).toEqual([]);
  });
  it('a host without sender_filled hides sender-filled and read-only', () => {
    const caps = { settings: ALL.settings.filter((k) => k !== 'sender_filled' && k !== 'read_only') };
    expect(editableSettingsOf('TEXT', caps)).not.toContain('sender_filled');
    expect(editableSettingsOf('TEXT', caps)).not.toContain('read_only');
  });
});

describe('settingsToWire / settingsFromWire', () => {
  it('a field with no settings sends none (set mode); all mode sends NULL for each setting the type takes', () => {
    expect(settingsToWire('TEXT', DEFAULT_SETTINGS)).toEqual({});
    expect(settingsToWire('SIGNATURE', DEFAULT_SETTINGS, { members: 'all' })).toEqual({ label: null, tooltip: null, data_name: null, condition: null });
    expect(settingsToWire('TEXT', DEFAULT_SETTINGS, { members: 'all' })).toEqual({
      label: null,
      tooltip: null,
      placeholder: null,
      read_only: false,
      sender_filled: false,
      validation: null,
      font_size: null,
      data_name: null,
      options: null,
      condition: null,
    });
  });

  it('label / tooltip / placeholder / data_name are trimmed; font_size is sent only when fixed', () => {
    expect(settingsToWire('TEXT', S({ label: ' Name ', tooltip: ' t ', placeholder: ' p ', dataName: ' full_name ', fontSize: 12 }))).toEqual({
      label: 'Name',
      tooltip: 't',
      placeholder: 'p',
      font_size: 12,
      data_name: 'full_name',
    });
  });

  it('a setting the type does not take is never sent', () => {
    expect(settingsToWire('SIGNATURE', S({ placeholder: 'x', fontSize: 10, groupKey: 'g', validation: 'email' }))).toEqual({});
    expect(settingsToWire('CHECKBOX', S({ placeholder: 'x' }))).toEqual({});
  });

  it('validation: only a preset of the type; its parameter only while it is chosen', () => {
    expect(settingsToWire('TEXT', S({ validation: 'email', options: { max_length: 9 } }))).toEqual({ validation: 'email' });
    expect(settingsToWire('TEXT', S({ validation: 'max_length', options: { max_length: 9 } }))).toEqual({ validation: 'max_length', options: { max_length: 9 } });
    expect(settingsToWire('MULTILINE_TEXT', S({ validation: 'email' }))).toEqual({});
    expect(settingsToWire('NUMBER', S({ validation: 'number_range', options: { min: 1, max: 5 } }))).toEqual({ validation: 'number_range', options: { min: 1, max: 5 } });
    expect(settingsToWire('NUMBER', S({ options: { min: 1, max: 5 } }))).toEqual({});
    expect(settingsToWire('DATE', S({ validation: 'date_range', options: { min_date: '2026-01-01', max_date: '' } }))).toEqual({ validation: 'date_range', options: { min_date: '2026-01-01' } });
  });

  it('NUMBER money format carries currency and decimals; plain drops the currency', () => {
    expect(optionsToWire('NUMBER', '', { format: 'money', currency: 'EUR', decimals: 2 })).toEqual({ format: 'money', currency: 'EUR', decimals: 2 });
    expect(optionsToWire('NUMBER', '', { currency: 'EUR', decimals: 0 })).toEqual({ decimals: 0 });
    expect(optionsToWire('NUMBER', '', null)).toBeNull();
  });

  it('DROPDOWN choices: trimmed, blank rows dropped, a blank value takes its label', () => {
    expect(cleanChoices([{ value: '', label: ' Yes ' }, { value: ' n ', label: '' }, { value: '', label: '  ' }])).toEqual([
      { value: 'Yes', label: 'Yes' },
      { value: 'n', label: 'n' },
    ]);
    expect(settingsToWire('DROPDOWN', S({ options: { choices: [{ value: 'a', label: 'A' }] } }))).toEqual({ options: { choices: [{ value: 'a', label: 'A' }] } });
  });

  it('RADIO: the group is sent; a new radio does not send its rule (always SELECT_ONE); all mode does', () => {
    const s = S({ groupKey: 'radio_1', groupRule: 'SELECT_ANY', minSelected: 2, label: 'Yes' });
    expect(settingsToWire('RADIO', s)).toEqual({ label: 'Yes', group_key: 'radio_1' });
    expect(settingsToWire('RADIO', s, { members: 'all' })).toMatchObject({ group_key: 'radio_1', group_rule: 'SELECT_ONE' });
    expect(settingsToWire('RADIO', s, { members: 'all' })).not.toHaveProperty('min_selected');
  });

  it('sender-filled: read_only only with it; the value only for a host that sends values', () => {
    expect(settingsToWire('TEXT', S({ readOnly: true }))).toEqual({});
    expect(settingsToWire('TEXT', S({ senderFilled: true, readOnly: true, senderValue: 'v' }))).toEqual({ read_only: true, sender_filled: true });
    expect(settingsToWire('TEXT', S({ senderFilled: true, senderValue: 'v' }), { senderValues: true })).toEqual({ sender_filled: true, value: 'v' });
    expect(settingsToWire('TEXT', S({ senderFilled: false, senderValue: 'v' }), { senderValues: true })).toEqual({});
  });

  it('SIGNER_NAME: name_mode always (set mode); NULL for the default in the template convention', () => {
    expect(settingsToWire('SIGNER_NAME', DEFAULT_SETTINGS)).toEqual({ name_mode: 'SIGNER_PROFILE' });
    expect(settingsToWire('SIGNER_NAME', DEFAULT_SETTINGS, { nameModeDefaultNull: true })).toEqual({});
  });

  it('round-trips every setting through the wire', () => {
    const wire = {
      label: 'Amount',
      tooltip: 'In dollars',
      placeholder: '0.00',
      read_only: true,
      sender_filled: true,
      validation: 'number_range',
      font_size: 11,
      data_name: 'amount',
      options: { format: 'money', currency: 'USD', decimals: 2, min: 0, max: 100 },
      value: '12.50',
    } as const;
    const s = settingsFromWire(wire);
    expect(s).toMatchObject({ label: 'Amount', tooltip: 'In dollars', placeholder: '0.00', readOnly: true, senderFilled: true, senderValue: '12.50', validation: 'number_range', fontSize: 11, dataName: 'amount' });
    expect(settingsToWire('NUMBER', s, { senderValues: true })).toEqual(wire);
  });
});

describe('settingsIssue — the ONE settings rule (parseFieldSettings) on the editor settings', () => {
  it('a dropdown with no choices is refused; with one it is fine', () => {
    expect(settingsIssue('DROPDOWN', S())?.reason).toBe('dropdown_choices_invalid');
    expect(settingsIssue('DROPDOWN', defaultSettingsFor('DROPDOWN', []))).toBeNull();
  });
  it('a bad data name, a range with no bound and a radio with no group are refused', () => {
    expect(settingsIssue('TEXT', S({ dataName: 'Bad Name' }))?.reason).toBe('data_name_invalid');
    expect(settingsIssue('NUMBER', S({ validation: 'number_range' }))?.reason).toBe('validation_params_invalid');
    expect(settingsIssue('NUMBER', S({ validation: 'number_range', options: { min: 5, max: 1 } }))?.reason).toBe('validation_params_invalid');
    expect(settingsIssue('RADIO', S())?.reason).toBe('radio_group_required');
    expect(settingsIssue('NUMBER', S({ options: { format: 'money', currency: 'usd' } }))?.reason).toBe('number_format_invalid');
  });
  it('sender-filled is refused while the host has not switched it on', () => {
    expect(settingsIssue('TEXT', S({ senderFilled: true }))?.reason).toBe('sender_filled_not_available');
    expect(settingsIssue('TEXT', S({ senderFilled: true }), { senderFilledEnabled: true })).toBeNull();
  });
});

describe('defaults and radio groups (T-5)', () => {
  it('a new RADIO gets the next free group and its first option text; a new DROPDOWN two choices', () => {
    expect(defaultSettingsFor('RADIO', [field('a')])).toMatchObject({ groupKey: 'radio_2', groupRule: 'SELECT_ONE', label: 'Option 1' });
    expect(defaultSettingsFor('DROPDOWN', []).options?.choices).toHaveLength(2);
    expect(defaultSettingsFor('TEXT', [])).toBe(DEFAULT_SETTINGS);
    expect(freeGroupKey('radio', new Set(['radio_1', 'radio_3']))).toBe('radio_2');
  });

  it('"Add option" places a sibling below in the same group with the next option text', () => {
    const a = field('a');
    const b = radioOptionBelow([a], a, 'b');
    expect(b).toMatchObject({ id: 'b', type: 'RADIO', x: 100, y: 500 - 18 - 8, settings: { groupKey: 'radio_1', label: 'Option 2' } });
    expect(nextRadioLabel([a, b], a)).toBe('Option 3');
  });

  it('a radio group shares required / read-only / sender-filled; its rule stays SELECT_ONE', () => {
    const fields = [field('a'), field('b', { settings: S({ groupKey: 'radio_1', groupRule: 'SELECT_ONE', label: 'Option 2' }) })];
    const next = applySettings(fields, 'a', { required: true, groupRule: 'SELECT_ANY' });
    expect(next.map((f) => f.required)).toEqual([true, true]);
    expect(next.map((f) => f.settings.groupRule)).toEqual(['SELECT_ONE', 'SELECT_ONE']);
    const sf = applySettings(next, 'b', { senderFilled: true });
    expect(sf.every((f) => f.settings.senderFilled)).toBe(true);
    expect(groupSize(sf, sf[0]!)).toBe(2);
  });

  it('the sender choosing one option clears the others; turning sender-filled off clears value and read-only', () => {
    let fields = [field('a'), field('b')].map((f) => ({ ...f, settings: { ...f.settings, senderFilled: true } }));
    fields = applySettings(fields, 'a', { senderValue: 'true' });
    fields = applySettings(fields, 'b', { senderValue: 'true' });
    expect(fields.map((f) => f.settings.senderValue)).toEqual(['false', 'true']);
    fields = applySettings(fields, 'a', { readOnly: true });
    fields = applySettings(fields, 'a', { senderFilled: false });
    expect(fields.map((f) => [f.settings.senderFilled, f.settings.readOnly, f.settings.senderValue])).toEqual([
      [false, false, ''],
      [false, false, ''],
    ]);
  });

  it('a check box never joins a radio group of the same key', () => {
    const fields = [field('a'), { ...field('c'), type: 'CHECKBOX', settings: S({ groupKey: 'radio_1' }) }];
    const next = applySettings(fields, 'a', { required: true });
    expect(next[1]!.required).toBe(false);
  });
});

// FIELD-PARITY-2 B-2 / B-3 — the condition travels on the wire and the editor sees the server's
// cross-field refusals.
describe('FIELD-PARITY-2 — condition on the wire and conditionIssues', () => {
  const placed = (id: string, type: string, condition: PlacementSettings['condition'] = null, assignee = 's1'): PlacedField => ({
    id,
    type,
    docId: 'd',
    page: 0,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    required: false,
    assignee,
    binding: null,
    settings: { ...DEFAULT_SETTINGS, condition },
  });

  it('a stored condition round-trips; a broken one reads as none', () => {
    const c = { trigger_key: 'agree', when: 'checked' as const };
    expect(settingsFromWire({ condition: c }).condition).toEqual(c);
    expect(settingsFromWire({ condition: { when: 'checked' } }).condition).toBeNull();
    expect(settingsToWire('TEXT', { ...DEFAULT_SETTINGS, condition: c })).toEqual({ condition: c });
    expect(settingsToWire('TEXT', DEFAULT_SETTINGS, { members: 'all' })).toMatchObject({ condition: null });
  });

  it('reports the server refusals by field id', () => {
    const issues = conditionIssues([
      placed('sig', 'SIGNATURE'),
      placed('agree', 'CHECKBOX'),
      placed('t', 'TEXT', { trigger_key: 'agree', when: 'checked' }),
      placed('u', 'TEXT', { trigger_key: 'agree', when: 'checked' }, 's2'),
      placed('v', 'TEXT', { trigger_key: 'gone', when: 'checked' }),
    ]);
    expect([...issues.entries()].map(([id, i]) => [id, i.reason])).toEqual([
      ['u', 'condition_cross_signer'],
      ['v', 'condition_trigger_unknown'],
    ]);
  });
});
