import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultSettingsFor } from '@aramo/field-placement-web';

import { FIXED_FORM_SETTINGS, fixedFormFieldsToPlaced, fixedFormFieldsToWire, fixedFormSettings } from './fixed-form-placement';
import type { FixedFormField } from './fixed-form-model';

// FIELD-PARITY-1 P1-3 × P1-5 — the console Studio carries the template field settings (label,
// check-box group, name mode) between the template API and the shared editor: an untouched
// field goes back byte-equal, an edited setting is sent, and a type never sends a setting it
// does not take.

const base = (o: Partial<FixedFormField> & { field_key: string; field_type: string }): FixedFormField => ({
  binding_key: null,
  signer_role: 'chair',
  required: true,
  page_number: 0,
  x: 72,
  y: 600,
  width: 18,
  height: 18,
  ordinal: 0,
  ...o,
});

const roundTrip = (fields: FixedFormField[], edit?: (p: ReturnType<typeof fixedFormFieldsToPlaced>) => ReturnType<typeof fixedFormFieldsToPlaced>) => {
  const placed = fixedFormFieldsToPlaced(fields);
  const next = edit ? edit(placed) : placed;
  return fixedFormFieldsToWire(next, new Map(fields.map((f) => [f.field_key, f])));
};

describe('fixed-form placement ↔ template field settings (FIELD-PARITY-1)', () => {
  it('FP1-S-1 an untouched field round-trips byte-equal, with or without stored settings', () => {
    const fields = [
      base({ field_key: 'checkbox_1', field_type: 'CHECKBOX', label: 'Approved', group_key: 'prev', group_rule: 'SELECT_ONE', min_selected: 1 }),
      base({ field_key: 'text_1', field_type: 'TEXT', ordinal: 1, width: 230, height: 22 }),
    ];
    expect(roundTrip(fields)).toEqual(fields);
  });

  it('FP1-S-2 stored settings reach the editor', () => {
    const [cb, name] = fixedFormFieldsToPlaced([
      base({ field_key: 'checkbox_1', field_type: 'CHECKBOX', label: 'Approved', group_key: 'prev', group_rule: 'SELECT_ONE', min_selected: 1 }),
      base({ field_key: 'name_1', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_ENTERED', ordinal: 1 }),
    ]);
    expect(cb?.settings).toMatchObject({ label: 'Approved', groupKey: 'prev', groupRule: 'SELECT_ONE', minSelected: 1 });
    expect(name?.settings.nameMode).toBe('SIGNER_ENTERED');
  });

  it('FP1-S-3 edited check-box settings are sent; clearing the group clears rule and minimum', () => {
    const fields = [base({ field_key: 'checkbox_1', field_type: 'CHECKBOX' })];
    const [set] = roundTrip(fields, (p) => p.map((f) => ({ ...f, settings: { ...f.settings, label: ' Approved ', groupKey: 'prev', groupRule: 'SELECT_ONE', minSelected: 1 } })));
    expect(set).toMatchObject({ label: 'Approved', group_key: 'prev', group_rule: 'SELECT_ONE', min_selected: 1 });
    const stored = [{ ...base({ field_key: 'checkbox_1', field_type: 'CHECKBOX' }), label: 'Approved', group_key: 'prev', group_rule: 'SELECT_ONE', min_selected: 1 }];
    const [cleared] = roundTrip(stored, (p) => p.map((f) => ({ ...f, settings: { ...f.settings, groupKey: '' } })));
    expect(cleared).toMatchObject({ label: 'Approved', group_key: null, group_rule: null, min_selected: null });
  });

  it('FP1-S-4 SIGNER_NAME sends name_mode; the default (signer profile) is stored as NULL', () => {
    const fields = [base({ field_key: 'name_1', field_type: 'SIGNER_NAME', name_mode: 'SIGNER_ENTERED' })];
    const [back] = roundTrip(fields, (p) => p.map((f) => ({ ...f, settings: { ...f.settings, nameMode: 'SIGNER_PROFILE' } })));
    expect(back?.name_mode).toBeNull();
  });

  it('FP1-S-5 a new TEXT field with no settings sends no settings members', () => {
    const placed = fixedFormFieldsToPlaced([base({ field_key: 'text_1', field_type: 'TEXT' })]);
    const wire = fixedFormFieldsToWire(placed, new Map());
    expect(Object.keys(wire[0] ?? {})).not.toEqual(expect.arrayContaining(['label']));
    expect(wire[0]).not.toHaveProperty('group_key');
    expect(wire[0]).not.toHaveProperty('name_mode');
  });

  // FIELD-PARITY-1 P3 §6.2 — the new types and settings.
  it('FP3-S-1 untouched fields with every P3 setting round-trip byte-equal (incl. a stored sender-filled one)', () => {
    const fields = [
      base({ field_key: 'dropdown_1', field_type: 'DROPDOWN', width: 180, height: 22, label: 'Plan', placeholder: 'Pick', tooltip: 'Your plan', data_name: 'plan', font_size: 10, options: { choices: [{ value: 'a', label: 'A' }] } }),
      base({ field_key: 'radio_1', field_type: 'RADIO', ordinal: 1, label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: null }),
      base({ field_key: 'radio_2', field_type: 'RADIO', ordinal: 2, label: 'No', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: null, y: 570 }),
      base({ field_key: 'number_1', field_type: 'NUMBER', ordinal: 3, validation: 'number_range', options: { format: 'money', currency: 'USD', decimals: 2, min: 0 } }),
      base({ field_key: 'date_1', field_type: 'DATE', ordinal: 4, validation: 'date_range', options: { max_date: '2026-12-31' } }),
      base({ field_key: 'multiline_text_1', field_type: 'MULTILINE_TEXT', ordinal: 5, validation: 'max_length', options: { max_length: 400 } }),
      base({ field_key: 'text_1', field_type: 'TEXT', ordinal: 6, sender_filled: true, read_only: true }),
      base({ field_key: 'ack_1', field_type: 'ACKNOWLEDGEMENT', ordinal: 7, label: 'I have read it' }),
    ];
    expect(roundTrip(fields)).toEqual(fields);
    // Moving one field changes only its position members.
    const moved = roundTrip(fields, (p) => p.map((f) => (f.id === 'number_1' ? { ...f, x: 80 } : f)));
    expect(moved[3]).toEqual({ ...fields[3], x: 80 });
  });

  it('FP3-S-2 an edited DROPDOWN sends every setting its type takes (cleared ones as NULL)', () => {
    const fields = [base({ field_key: 'dropdown_1', field_type: 'DROPDOWN', placeholder: 'Pick', options: { choices: [{ value: 'a', label: 'A' }] } })];
    const [back] = roundTrip(fields, (p) =>
      p.map((f) => ({ ...f, settings: { ...f.settings, placeholder: '', options: { choices: [{ value: 'a', label: 'A' }, { value: '', label: 'B' }] } } })),
    );
    expect(back).toMatchObject({
      label: null,
      tooltip: null,
      placeholder: null,
      read_only: false,
      sender_filled: false,
      font_size: null,
      data_name: null,
      options: { choices: [{ value: 'a', label: 'A' }, { value: 'B', label: 'B' }] },
    });
    expect(back).not.toHaveProperty('validation');
    expect(back).not.toHaveProperty('group_key');
  });

  it('FP3-S-3 new RADIO set, DROPDOWN and NUMBER money fields send exactly what is set', () => {
    const at = (id: string, type: string, settings: typeof DEFAULT_SETTINGS) => ({
      id,
      type,
      docId: 'form',
      page: 0,
      x: 72,
      y: 600,
      width: 18,
      height: 18,
      required: false,
      assignee: 'chair',
      binding: null,
      settings,
    });
    const r1 = defaultSettingsFor('RADIO', []);
    const wire = fixedFormFieldsToWire(
      [
        at('radio_1', 'RADIO', r1),
        at('radio_2', 'RADIO', { ...r1, label: 'Option 2' }),
        at('dropdown_1', 'DROPDOWN', defaultSettingsFor('DROPDOWN', [])),
        at('number_1', 'NUMBER', { ...DEFAULT_SETTINGS, options: { format: 'money', currency: 'EUR', decimals: 2 } }),
      ],
      new Map(),
    );
    expect(wire.map(({ field_key, field_type, ordinal, ...rest }) => ({ field_key, field_type, ordinal, settings: Object.fromEntries(Object.entries(rest).filter(([k]) => !['binding_key', 'signer_role', 'required', 'page_number', 'x', 'y', 'width', 'height'].includes(k))) }))).toEqual([
      { field_key: 'radio_1', field_type: 'RADIO', ordinal: 0, settings: { label: 'Option 1', group_key: 'radio_1' } },
      { field_key: 'radio_2', field_type: 'RADIO', ordinal: 1, settings: { label: 'Option 2', group_key: 'radio_1' } },
      { field_key: 'dropdown_1', field_type: 'DROPDOWN', ordinal: 2, settings: { options: { choices: [{ value: 'Option 1', label: 'Option 1' }, { value: 'Option 2', label: 'Option 2' }] } } },
      { field_key: 'number_1', field_type: 'NUMBER', ordinal: 3, settings: { options: { format: 'money', currency: 'EUR', decimals: 2 } } },
    ]);
  });

  it('FP3-S-4 the Studio offers every template setting but sender-filled / read-only (dark; no flag in the view)', () => {
    // FIELD-PARITY-2 B-7 — "Show only when…" (condition) is offered with its control.
    expect(FIXED_FORM_SETTINGS).toEqual(['label', 'group_key', 'group_rule', 'min_selected', 'name_mode', 'tooltip', 'placeholder', 'validation', 'font_size', 'data_name', 'options', 'condition']);
    // A stored sender-filled field still reaches the editor (and goes back unchanged, FP3-S-1).
    const [f] = fixedFormFieldsToPlaced([base({ field_key: 'text_1', field_type: 'TEXT', sender_filled: true, read_only: true })]);
    expect(f?.settings).toMatchObject({ senderFilled: true, readOnly: true });
  });

  it('FP2 A-4 the Studio offers sender-filled / read-only only when the view says the server flag is on', () => {
    expect(fixedFormSettings({ sender_filled_fields_enabled: false })).toEqual(FIXED_FORM_SETTINGS);
    expect(fixedFormSettings(null)).toEqual(FIXED_FORM_SETTINGS);
    expect(fixedFormSettings({})).toEqual(FIXED_FORM_SETTINGS);
    expect(fixedFormSettings({ sender_filled_fields_enabled: true })).toEqual([
      'label', 'group_key', 'group_rule', 'min_selected', 'name_mode', 'tooltip', 'placeholder', 'read_only', 'sender_filled', 'validation', 'font_size', 'data_name', 'options', 'condition',
    ]);
  });
});

describe('fixed-form placement ↔ conditions (FIELD-PARITY-2 B-7)', () => {
  const agree = base({ field_key: 'checkbox_1', field_type: 'CHECKBOX', label: 'Co-applicant' });
  const coName = base({ field_key: 'text_1', field_type: 'TEXT', ordinal: 1, width: 230, height: 22, condition: { trigger_key: 'checkbox_1', when: 'checked' } });

  it('FP2-B7-1 untouched fields round-trip byte-equal, the condition included', () => {
    const fields = [agree, coName];
    expect(roundTrip(fields)).toEqual(fields);
    expect(fixedFormFieldsToPlaced(fields)[1]!.settings.condition).toEqual({ trigger_key: 'checkbox_1', when: 'checked' });
  });

  it('FP2-B7-2 a condition set in the editor is sent; another edit keeps it; clearing it sends null', () => {
    const [, set] = roundTrip([agree, { ...coName, condition: null }], (p) =>
      p.map((f) => (f.id === 'text_1' ? { ...f, settings: { ...f.settings, condition: { trigger_key: 'checkbox_1', when: 'unchecked' } } } : f)),
    );
    expect(set).toMatchObject({ field_key: 'text_1', condition: { trigger_key: 'checkbox_1', when: 'unchecked' } });
    const [, kept] = roundTrip([agree, coName], (p) => p.map((f) => (f.id === 'text_1' ? { ...f, settings: { ...f.settings, tooltip: 'If any' } } : f)));
    expect(kept).toMatchObject({ tooltip: 'If any', condition: { trigger_key: 'checkbox_1', when: 'checked' } });
    const [, cleared] = roundTrip([agree, coName], (p) => p.map((f) => (f.id === 'text_1' ? { ...f, settings: { ...f.settings, condition: null } } : f)));
    expect(cleared).toMatchObject({ condition: null });
  });

  it('FP2-B7-3 a new field goes out with its condition (and none when it has none)', () => {
    const placed = fixedFormFieldsToPlaced([agree]);
    const fresh = { ...placed[0]!, id: 'text_2', type: 'TEXT', settings: { ...DEFAULT_SETTINGS, condition: { trigger_key: 'checkbox_1', when: 'checked' as const } } };
    const wire = fixedFormFieldsToWire([...placed, fresh, { ...fresh, id: 'text_3', settings: DEFAULT_SETTINGS }], new Map([[agree.field_key, agree]]));
    expect(wire[1]).toMatchObject({ field_key: 'text_2', condition: { trigger_key: 'checkbox_1', when: 'checked' } });
    expect(wire[2]).not.toHaveProperty('condition');
  });
});
