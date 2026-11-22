import { describe, expect, it } from 'vitest';

import type { EnvelopeField } from '../api';

import { toPlaced, toWire } from './PrepareEditor';

// FIELD-PARITY-1 P1-5 — Prepare on the shared editor sends the same PUT payload as before:
// PDF-native boxes unchanged, a field's configuration only for its type, no id on an authored
// field, and an engine-only field sent back exactly as stored.

const stored: EnvelopeField[] = [
  { id: 'f1', envelope_document_id: 'd1', signer_id: 's1', field_type: 'SIGNATURE', page_number: 0, x: 72.5, y: 100, width: 230, height: 50, required: true },
  { id: 'f2', envelope_document_id: 'd1', signer_id: 's1', field_type: 'CHECKBOX', page_number: 1, x: 10, y: 20, width: 18, height: 18, required: false, label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE', min_selected: null },
  { id: 'f3', envelope_document_id: 'd1', signer_id: 's2', field_type: 'SIGNER_NAME', page_number: 0, x: 1, y: 2, width: 200, height: 22, required: true, name_mode: 'SIGNER_ENTERED' },
  { id: 'f4', envelope_document_id: 'd1', signer_id: 's2', field_type: 'ACKNOWLEDGEMENT', page_number: 0, x: 5, y: 6, width: 400, height: 26, required: true },
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
