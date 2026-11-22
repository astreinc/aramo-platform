import { describe, expect, it } from 'vitest';

import { SENDER_ENTERED, fieldValueLines, radioGroupLines, valuePlacement, type PlacementField } from '../lib/execution.service.js';
import { evaluateSignerFieldRules } from '../lib/domain/field-rules.js';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6
// (Rendering) — how the executed PDF prints the new types, and the certificate lines.

const stampFor = (): { label: string; id: string } => ({ label: 'Signed by:', id: 'ABC' });
const field = (over: Partial<PlacementField>): PlacementField => ({
  id: 'f1',
  field_type: 'TEXT',
  signer_id: 's1',
  page_number: 0,
  x: 72,
  y: 120,
  width: 180,
  height: 22,
  value: 'x',
  signature_method: null,
  ...over,
});

describe('valuePlacement — the new types (P3)', () => {
  it('DATE prints in the envelope date format (default MM/DD/YYYY)', () => {
    expect(valuePlacement(field({ field_type: 'DATE', value: '2026-03-04' }), stampFor)).toMatchObject({ value: '03/04/2026' });
    expect(valuePlacement(field({ field_type: 'DATE', value: '2026-03-04' }), stampFor, { date_format: 'DD/MM/YYYY' })).toMatchObject({ value: '04/03/2026' });
  });

  it('NUMBER prints formatted; money with its currency', () => {
    expect(valuePlacement(field({ field_type: 'NUMBER', value: '1250.5', options: { format: 'money', currency: 'USD', decimals: 2 } }), stampFor)).toMatchObject({ value: '$1,250.50' });
    expect(valuePlacement(field({ field_type: 'NUMBER', value: '1250.5' }), stampFor)).toMatchObject({ value: '1,250.5' });
  });

  it('DROPDOWN prints the chosen label; MULTILINE_TEXT keeps its lines and its box (wrapped by the stamper)', () => {
    expect(valuePlacement(field({ field_type: 'DROPDOWN', value: 'ny', options: { choices: [{ value: 'ny', label: 'New York' }] } }), stampFor)).toMatchObject({ value: 'New York' });
    expect(valuePlacement(field({ field_type: 'MULTILINE_TEXT', value: 'a\nb', height: 66 }), stampFor)).toMatchObject({ value: 'a\nb', width: 180, height: 66 });
  });

  it('font_size (S-7) travels only with a boxed value; earlier types print exactly as before', () => {
    expect(valuePlacement(field({ font_size: 9 }), stampFor)).toMatchObject({ font_size: 9 });
    expect(valuePlacement(field({ font_size: 9, width: null, height: null }), stampFor)).not.toHaveProperty('font_size');
    expect(valuePlacement(field({ value: 'Jane Doe' }), stampFor)).toEqual({ field_key: 'f1', page_number: 0, x: 72, y: 120, value: 'Jane Doe', width: 180, height: 22 });
  });
});

describe('certificate lines (P3)', () => {
  const at = new Date('2026-05-01T00:00:00Z');
  const row = (over: Record<string, unknown>) => ({ signer_id: 's1', field_type: 'TEXT', label: null, page_number: 0, value: null, filled_at: null, group_key: null, sender_filled: false, options: null, ...over });

  it('one line per new-type value (label if set, printed value), and a sender-filled value marked', () => {
    const lines = fieldValueLines(
      [
        row({ field_type: 'DATE', label: 'Effective date', value: '2026-03-04', filled_at: at }),
        row({ field_type: 'NUMBER', value: '99', filled_at: at, options: { format: 'money', currency: 'USD', decimals: 2 }, sender_filled: true }),
        row({ field_type: 'DROPDOWN', value: null }),
        row({ field_type: 'TEXT', label: 'Reference', value: 'PO-7', filled_at: at, sender_filled: true }),
        row({ field_type: 'TEXT', label: 'Plain text', value: 'not listed', filled_at: at }),
        row({ field_type: 'DATE', signer_id: 's2', value: '2026-01-01', filled_at: at }),
      ],
      's1',
      'DD/MM/YYYY',
    );
    expect(lines).toEqual([
      '"Effective date": 04/03/2026',
      `Number (page 1): $99.00${SENDER_ENTERED}`,
      'Dropdown (page 1): not filled',
      `"Reference": PO-7${SENDER_ENTERED}`,
    ]);
    expect(SENDER_ENTERED).toBe(' (entered by the sender before sending)');
  });

  it('a multi-line value is one line on the certificate, cut at 300 characters', () => {
    const [line] = fieldValueLines([row({ field_type: 'MULTILINE_TEXT', label: 'Minutes', value: `a\nb ${'x'.repeat(400)}`, filled_at: at })], 's1', null);
    expect(line?.startsWith('"Minutes": a b x')).toBe(true);
    expect(line?.endsWith('…')).toBe(true);
    expect(line!.length).toBeLessThanOrEqual('"Minutes": '.length + 300);
  });

  it('one line per radio group: the chosen option (or none); a sender-filled group is marked', () => {
    const r = (label: string, value: string | null, over: Record<string, unknown> = {}) => row({ field_type: 'RADIO', group_key: 'vote', label, value, filled_at: value === null ? null : at, ...over });
    expect(radioGroupLines([r('Yes', 'false'), r('No', 'true')], 's1')).toEqual(['Radio group "vote": "No"']);
    expect(radioGroupLines([r('Yes', null), r('No', null)], 's1')).toEqual(['Radio group "vote": none chosen']);
    expect(radioGroupLines([r('Yes', 'true', { sender_filled: true }), r('No', 'false', { sender_filled: true })], 's1')).toEqual([`Radio group "vote": "Yes"${SENDER_ENTERED}`]);
    expect(fieldValueLines([r('Yes', 'true')], 's1', null)).toEqual([]);
  });
});

describe('signer completion (P3, the shared rule the server runs)', () => {
  const at = new Date();
  it('a required radio group needs one choice; a sender-filled field never blocks', () => {
    const radio = (id: string, value: string | null) => ({ id, field_type: 'RADIO', required: true, value, filled_at: value === null ? null : at, group_key: 'v', group_rule: 'SELECT_ONE' });
    expect(evaluateSignerFieldRules([radio('a', null), radio('b', null)])).toEqual({ reason: 'radio_group_select_one', group_key: 'v' });
    expect(evaluateSignerFieldRules([radio('a', 'true'), radio('b', 'false')])).toBeNull();
    expect(evaluateSignerFieldRules([{ id: 't', field_type: 'TEXT', required: true, value: null, filled_at: null, sender_filled: true }])).toBeNull();
  });
});
