// FIELD-PARITY-2 A-1 (G-3) — a self-sign started from a template never loses a field: every
// template field and every setting it carries goes back on the replace-all fields PUT, and a
// field the user did not change goes back exactly as stored.
import { workspaceWith } from '../../inbox/__tests__/fixtures';
import { createSelfFromTemplate, selfFieldsWire, startFromTemplate } from '../selfSignFlow';

const PDF = new Uint8Array(
  Buffer.from(
    '%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n' +
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\nstartxref\n0\n%%EOF\n',
    'latin1',
  ),
);

const base = {
  envelope_document_id: 'doc-t',
  signer_id: 'r-self',
  page_number: 0,
  name_mode: null,
  label: null,
  group_key: null,
  group_rule: null,
  min_selected: null,
};

// Stored fields as the server returns them (every member the PUT carries).
const FIELDS = [
  { id: 'f-sig', ...base, field_type: 'SIGNATURE', x: 100, y: 642.37, width: 230, height: 50, required: true },
  {
    id: 'f-box',
    ...base,
    field_type: 'CHECKBOX',
    x: 40.5,
    y: 500.25,
    width: 14,
    height: 14,
    required: false,
    label: 'I agree',
    group_key: 'terms',
    group_rule: 'SELECT_ANY',
    min_selected: 1,
    tooltip: 'Tick to agree',
  },
  {
    id: 'f-drop',
    ...base,
    field_type: 'DROPDOWN',
    x: 100,
    y: 400,
    width: 160,
    height: 24,
    required: true,
    tooltip: 'Pick one',
    data_name: 'plan',
    options: { choices: [{ value: 'a', label: 'Plan A' }, { value: 'b', label: 'Plan B' }] },
  },
  {
    id: 'f-date',
    ...base,
    field_type: 'DATE',
    x: 300,
    y: 400,
    width: 120,
    height: 22,
    required: false,
    validation: 'date_range',
    options: { min_date: '2026-01-01', max_date: '2026-12-31' },
  },
  { id: 'f-radio1', ...base, field_type: 'RADIO', x: 100, y: 300, width: 14, height: 14, required: true, label: 'Yes', group_key: 'g1' },
  { id: 'f-radio2', ...base, field_type: 'RADIO', x: 140, y: 300, width: 14, height: 14, required: true, label: 'No', group_key: 'g1' },
  {
    id: 'f-num',
    ...base,
    field_type: 'NUMBER',
    x: 100,
    y: 250,
    width: 100,
    height: 22,
    required: false,
    validation: 'number_range',
    options: { format: 'money', currency: 'USD', decimals: 2, min: 1, max: 500 },
  },
  { id: 'f-ml', ...base, field_type: 'MULTILINE_TEXT', x: 100, y: 150, width: 300, height: 80, required: false, placeholder: 'Notes' },
  { id: 'f-ack', ...base, field_type: 'ACKNOWLEDGEMENT', x: 100, y: 120, width: 200, height: 22, required: true },
  // An engine row with no recipient or size (S2S / Sign API): sent back only with its id.
  { id: 'f-engine', ...base, signer_id: null, field_type: 'ACKNOWLEDGEMENT', x: 10, y: 10, width: null, height: null, required: false },
];

const ENVELOPE = {
  id: 'env-t',
  revision: 2,
  status: 'DRAFT',
  documents: [{ id: 'doc-t', title: 'Lease' }],
  recipients: [{ id: 'r-self', name: 'Priya', email: 'p@example.com', recipient_kind: 'SIGNER' }],
  fields: FIELDS,
};

async function start() {
  const { workspace } = workspaceWith(() => ({ status: 201, body: { envelope: ENVELOPE } }));
  return startFromTemplate(
    { createFromTemplate: createSelfFromTemplate(workspace), fetchSource: async () => PDF },
    { templateId: 'tpl-1', values: {}, idempotencyKey: 'key-12345678' },
  );
}

/** Canonical JSON of a field's members without its id (key order does not matter on the wire). */
const canon = (o: object): string => {
  const { id: _id, ...rest } = o as { id?: string };
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]))
        : v;
  return JSON.stringify(sort(rest));
};

describe('self-sign from a template (FIELD-PARITY-2 A-1)', () => {
  it('sends back every template field, untouched ones exactly as stored', async () => {
    const r = await start();
    const wire = selfFieldsWire(r.fields, r.docs, 'r-self', r.progress.template);
    expect(wire).toHaveLength(FIELDS.length);
    for (const stored of FIELDS) {
      const sent = wire.find(
        (w) => w.field_type === stored.field_type && w.x === stored.x && w.y === stored.y && w.signer_id === stored.signer_id,
      );
      expect(sent).toBeDefined();
      // Byte-equal: the same members and values, in the same JSON.
      expect(canon(sent!)).toBe(canon(stored));
    }
    // The engine row keeps its id (the server keeps it only when identical).
    expect(wire.find((w) => w.id === 'f-engine')).toBeDefined();
  });

  it('a changed field keeps every setting it carries', async () => {
    const r = await start();
    const moved = r.fields.map((f) => (f.type === 'CHECKBOX' ? { ...f, x: f.x + 10 } : f));
    const wire = selfFieldsWire(moved, r.docs, 'r-self', r.progress.template);
    expect(wire).toHaveLength(FIELDS.length);
    const box = wire.find((w) => w.field_type === 'CHECKBOX');
    expect(box).toMatchObject({ x: 50.5, label: 'I agree', group_key: 'terms', group_rule: 'SELECT_ANY', min_selected: 1, tooltip: 'Tick to agree' });
  });

  it('places every template field but the engine row, with its settings', async () => {
    const r = await start();
    expect(r.fields.map((f) => f.type)).toEqual(FIELDS.slice(0, -1).map((f) => f.field_type));
    expect(r.progress.template?.preserved.map((f) => f.id)).toEqual(['f-engine']);
    expect(r.fields.find((f) => f.type === 'DROPDOWN')).toMatchObject({ tooltip: 'Pick one', dataName: 'plan', options: (FIELDS[2] as { options: unknown }).options });
    expect(r.fields.filter((f) => f.type === 'RADIO').map((f) => [f.label, f.groupKey])).toEqual([['Yes', 'g1'], ['No', 'g1']]);
  });

  it('a field the user deleted is not sent; every other one is', async () => {
    const r = await start();
    const kept = r.fields.filter((f) => f.type !== 'SIGNATURE');
    const wire = selfFieldsWire(kept, r.docs, 'r-self', r.progress.template);
    expect(wire.map((w) => w.field_type)).not.toContain('SIGNATURE');
    expect(wire).toHaveLength(FIELDS.length - 1);
  });
});
