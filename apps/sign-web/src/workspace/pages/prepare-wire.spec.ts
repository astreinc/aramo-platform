import { describe, expect, it } from 'vitest';

import type { EnvelopeField } from '../api';

import { P3_PENDING_WEB_TYPES, PREPARE_SETTINGS, V1_TYPES, prepareCapabilities, toPlaced, toWire } from './PrepareEditor';

// FIELD-PARITY-1 P1-5 — Prepare on the shared editor sends the same PUT payload as before:
// PDF-native boxes unchanged, a field's configuration only for its type, no id on an authored
// field, and an engine-only field sent back exactly as stored.

const stored: EnvelopeField[] = [
  { id: 'f1', envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72.5, y: 100, width: 230, height: 50, required: true },
  { id: 'f2', envelope_document_id: 'd1', signer_id: 's1', field_type: 'CHECKBOX', page_number: 1, x: 10, y: 20, width: 18, height: 18, required: false, label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: null },
  { id: 'f3', envelope_document_id: 'd1', signer_id: 's2', field_type: 'SIGNER_NAME', page_number: 0, x: 1, y: 2, width: 200, height: 22, required: true, name_mode: 'SIGNER_ENTERED' },
  // An engine row (S2S / Sign API): no recipient — kept locked and sent back unchanged with its id.
  { id: 'f4', envelope_document_id: 'd1', signer_id: null as unknown as string, field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 5, y: 6, width: 400, height: 26, required: true },
];

describe('Prepare wire mapping', () => {
  it('round-trips stored fields into the same payload as before P1-5', () => {
    const placed = stored.map(toPlaced);
    expect(placed[3]).toMatchObject({ locked: true });
    expect(placed.slice(0, 3).every((f) => f.locked !== true)).toBe(true);
    const wire = toWire(placed, new Map(stored.map((f, i) => [placed[i]!.id, f])));
    expect(wire).toEqual([
      { envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72.5, y: 100, width: 230, height: 50, required: true },
      { envelope_document_id: 'd1', signer_id: 's1', field_type: 'CHECKBOX', page_number: 1, x: 10, y: 20, width: 18, height: 18, required: false, label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE' },
      { envelope_document_id: 'd1', signer_id: 's2', field_type: 'SIGNER_NAME', page_number: 0, x: 1, y: 2, width: 200, height: 22, required: true, name_mode: 'SIGNER_ENTERED' },
      stored[3],
    ]);
    // Key order is the pre-P1-5 literal's.
    expect(Object.keys(wire[0]!)).toEqual(['envelope_document_id', 'signer_id', 'field_type', 'page_number', 'x', 'y', 'width', 'height', 'required']);
  });
});

// FIELD-PARITY-1 P3 §6 — Prepare authors ACKNOWLEDGEMENT and the new types with every setting.
describe('Prepare — Phase 3 types and settings on the wire', () => {
  const at = (o: Partial<EnvelopeField> & Pick<EnvelopeField, 'id' | 'field_type'>): EnvelopeField => ({ envelope_document_id: 'd1', signer_id: 's1', page_number: 0, x: 10, y: 20, width: 120, height: 22, required: false, ...o });
  const roundTrip = (fields: EnvelopeField[]) => {
    const placed = fields.map(toPlaced);
    return { placed, wire: toWire(placed, new Map(fields.map((f, i) => [placed[i]!.id, f]))) };
  };

  it('nothing is pending: every send_web type but PAYMENT is authorable', () => {
    expect(P3_PENDING_WEB_TYPES.size).toBe(0);
    for (const t of ['ACKNOWLEDGEMENT', 'DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT'] as const) expect(V1_TYPES.has(t)).toBe(true);
    expect(V1_TYPES.has('PAYMENT')).toBe(false);
  });

  it('a stored ACKNOWLEDGEMENT with a recipient is authorable (sent without id); one without stays locked', () => {
    const { placed, wire } = roundTrip([at({ id: 'a1', field_type: 'ACKNOWLEDGEMENT', label: 'I agree', width: 400, height: 26, required: true })]);
    expect(placed[0]!.locked).toBeUndefined();
    expect(wire[0]).toEqual({ envelope_document_id: 'd1', signer_id: 's1', field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 10, y: 20, width: 400, height: 26, required: true, label: 'I agree' });
  });

  it('every setting of the new types round-trips unchanged', () => {
    const fields: EnvelopeField[] = [
      at({ id: 'd', field_type: 'DROPDOWN', label: 'Plan', placeholder: 'Pick one', tooltip: 'Your plan', data_name: 'plan', font_size: 10, options: { choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } }),
      at({ id: 'r1', field_type: 'RADIO', label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE', width: 18, height: 18 }),
      at({ id: 'n', field_type: 'NUMBER', validation: 'number_range', options: { format: 'money', currency: 'USD', decimals: 2, min: 0, max: 100 } }),
      at({ id: 'dt', field_type: 'DATE', validation: 'date_range', options: { min_date: '2026-01-01', max_date: '2026-12-31' } }),
      at({ id: 'm', field_type: 'MULTILINE_TEXT', validation: 'max_length', options: { max_length: 500 }, width: 230, height: 66 }),
      at({ id: 't', field_type: 'TEXT', validation: 'email', placeholder: 'you@example.com' }),
    ];
    const { wire } = roundTrip(fields);
    const strip = ({ id: _id, group_rule, ...rest }: EnvelopeField) => (rest.field_type === 'RADIO' ? rest : { ...rest, ...(group_rule != null ? { group_rule } : {}) });
    expect(wire).toEqual(fields.map(strip));
  });

  it('sender-filled: the value and read-only travel; capabilities offer them only when the server flag is on', () => {
    const { wire } = roundTrip([at({ id: 's', field_type: 'TEXT', sender_filled: true, read_only: true, value: 'ACME Corp' })]);
    expect(wire[0]).toMatchObject({ read_only: true, sender_filled: true, value: 'ACME Corp' });
    expect(prepareCapabilities({}).settings).toEqual(PREPARE_SETTINGS);
    expect(prepareCapabilities({}).senderValues).toBe(false);
    expect(prepareCapabilities({ sender_filled_fields_enabled: true }).settings).toEqual([...PREPARE_SETTINGS, 'read_only', 'sender_filled']);
    expect(prepareCapabilities({ sender_filled_fields_enabled: true }).senderValues).toBe(true);
  });

  it('a new RADIO / DROPDOWN placed by the editor goes out with its group / choices', () => {
    const wire = toWire(
      [
        { id: 'x', type: 'RADIO', docId: 'd1', page: 0, x: 1, y: 2, width: 18, height: 18, required: true, assignee: 's1', binding: null, settings: { ...toPlaced(at({ id: 'q', field_type: 'RADIO', group_key: 'radio_1', label: 'Option 1' })).settings } },
      ],
      new Map(),
    );
    expect(wire[0]).toEqual({ envelope_document_id: 'd1', signer_id: 's1', field_type: 'RADIO', page_number: 0, x: 1, y: 2, width: 18, height: 18, required: true, label: 'Option 1', group_key: 'radio_1' });
  });
});
