import { describe, expect, it } from 'vitest';

import { fixedFormFieldsToPlaced, fixedFormFieldsToWire } from './fixed-form-placement';
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

  it('FP1-S-5 a new TEXT field sends no settings members (the type takes none)', () => {
    const placed = fixedFormFieldsToPlaced([base({ field_key: 'text_1', field_type: 'TEXT' })]);
    const wire = fixedFormFieldsToWire(placed, new Map());
    expect(Object.keys(wire[0] ?? {})).not.toEqual(expect.arrayContaining(['label']));
    expect(wire[0]).not.toHaveProperty('group_key');
    expect(wire[0]).not.toHaveProperty('name_mode');
  });
});
