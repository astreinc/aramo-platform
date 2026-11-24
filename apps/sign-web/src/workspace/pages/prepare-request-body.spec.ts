import { describe, expect, it } from 'vitest';

import { envelopeFieldToWire, type EnvelopeField } from '../api';

import { toPlaced, toWire } from './PrepareEditor';

// FIELD-PARITY-2 B-1 / B-2 — the request body PUT …/fields actually sends, end to end (the
// editor's toWire, then senderApi.fields' per-field mapping). The save replaces every field, so a
// field's key and its "show only when" must reach the body, or the server stores none and the
// signer page shows every field always (prod 2026-11-23: conditions set on Prepare were lost).

const stored: EnvelopeField[] = [
  { id: 'r1', field_key: 'co_box', envelope_document_id: 'd1', signer_id: 's1', field_type: 'CHECKBOX', page_number: 0, x: 75, y: 748, width: 18, height: 18, required: false, label: 'Has a co-applicant' },
  { id: 'r2', field_key: 'co_name', envelope_document_id: 'd1', signer_id: 's1', field_type: 'TEXT', page_number: 0, x: 121, y: 746, width: 200, height: 22, required: false, label: 'Co-applicant name', condition: { trigger_key: 'co_box', when: 'checked' } },
  {
    id: 'r3',
    field_key: 'pay',
    envelope_document_id: 'd1',
    signer_id: 's1',
    field_type: 'DROPDOWN',
    page_number: 0,
    x: 432,
    y: 720,
    width: 120,
    height: 22,
    required: false,
    label: 'Payment method',
    options: { choices: [{ value: 'Card', label: 'Card' }, { value: 'Bank transfer', label: 'Bank transfer' }, { value: 'Cheque', label: 'Cheque' }] },
  },
  { id: 'r4', field_key: 'bank', envelope_document_id: 'd1', signer_id: 's1', field_type: 'TEXT', page_number: 0, x: 173, y: 724, width: 200, height: 22, required: false, label: 'Bank account number', condition: { trigger_key: 'pay', when: 'one_of', values: ['Bank transfer'] } },
  { id: 'r5', field_key: 'sig', envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 331, y: 609, width: 230, height: 50, required: true },
];

const body = (fields: EnvelopeField[]) => {
  const placed = fields.map(toPlaced);
  return toWire(placed, new Map(fields.map((f, i) => [placed[i]!.id, f]))).map(envelopeFieldToWire);
};

describe('PUT …/fields request body', () => {
  it('every field carries its field_key', () => {
    expect(body(stored).map((f) => f['field_key'])).toEqual(['co_box', 'co_name', 'pay', 'bank', 'sig']);
  });

  it('a conditional field carries its condition; an unconditional one sends none', () => {
    const wire = body(stored);
    expect(wire[1]).toMatchObject({ field_key: 'co_name', condition: { trigger_key: 'co_box', when: 'checked' } });
    expect(wire[3]).toMatchObject({ field_key: 'bank', condition: { trigger_key: 'pay', when: 'one_of', values: ['Bank transfer'] } });
    for (const i of [0, 2, 4]) expect(wire[i]).not.toHaveProperty('condition');
  });

  it('a field without a key or condition sends neither (a legacy field is unchanged)', () => {
    const legacy: EnvelopeField = { envelope_document_id: 'd1', signer_id: 's1', field_type: 'TEXT', page_number: 0, x: 1, y: 2, width: 3, height: 4, required: false, field_key: null, condition: null };
    expect(envelopeFieldToWire(legacy)).toEqual({ envelope_document_id: 'd1', signer_id: 's1', field_type: 'TEXT', page_number: 0, x: 1, y: 2, width: 3, height: 4, required: false });
  });
});
