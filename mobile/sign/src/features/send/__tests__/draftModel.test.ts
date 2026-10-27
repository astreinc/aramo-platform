// M-A6 §2 — the draft model carries Name and Checkbox configuration both ways, and a
// field type the editor does not author is preserved untouched (never dropped on load,
// so the replace-all fields PUT does not delete it).
import { parseEnvelope, payloadFromServer } from '../draftModel';
import { fieldsToWire } from '../syncDraft';

const PAGE = { width: 612, height: 792 };

function detail(fields: Record<string, unknown>[]) {
  return parseEnvelope({
    id: 'e1',
    subject: 'S',
    status: 'DRAFT',
    editable: true,
    revision: 3,
    documents: [{ id: 'd1', title: 'Doc' }],
    recipients: [{ id: 's1', name: 'Ana', email: 'a@x.test', status: 'PENDING', signing_order: 1 }],
    fields,
  });
}

const geo = { envelope_document_id: 'd1', signer_id: 's1', page_number: 0, width: 18, height: 18 };

describe('draft model — Name and Checkbox (M-A6 §2)', () => {
  const env = detail([
    {
      ...geo,
      field_type: 'SIGNER_NAME',
      x: 72,
      y: 100,
      width: 200,
      height: 22,
      required: true,
      name_mode: 'SIGNER_ENTERED',
    },
    {
      ...geo,
      field_type: 'CHECKBOX',
      x: 72,
      y: 200,
      required: true,
      label: 'Option A',
      group_key: 'g',
      group_rule: 'SELECT_ANY',
      min_selected: 2,
    },
    {
      ...geo,
      field_type: 'CHECKBOX',
      x: 72,
      y: 230,
      required: true,
      label: null,
      group_key: 'g',
      group_rule: 'SELECT_ANY',
      min_selected: 2,
    },
    { ...geo, field_type: 'ACKNOWLEDGEMENT', x: 300, y: 300, required: true },
  ]);
  const { payload } = payloadFromServer(env, '"e1.3"', new Map([['d1', [PAGE]]]));

  it('loads the configuration into the editor fields', () => {
    expect(payload.fields.map((f) => f.type)).toEqual(['SIGNER_NAME', 'CHECKBOX', 'CHECKBOX']);
    expect(payload.fields[0]).toMatchObject({ nameMode: 'SIGNER_ENTERED' });
    expect(payload.fields[1]).toMatchObject({
      label: 'Option A',
      groupKey: 'g',
      groupRule: 'SELECT_ANY',
      minSelected: 2,
    });
  });

  it('keeps a non-authoring type untouched instead of dropping it', () => {
    expect(payload.preservedFields).toEqual([
      expect.objectContaining({ field_type: 'ACKNOWLEDGEMENT', x: 300, y: 300, signer_id: 's1' }),
    ]);
  });

  it('sends the configuration and the preserved field back, and never a value', () => {
    const wire = fieldsToWire(payload);
    expect(wire).toHaveLength(4);
    expect(wire[0]).toMatchObject({
      field_type: 'SIGNER_NAME',
      name_mode: 'SIGNER_ENTERED',
      y: 100,
    });
    expect(wire[1]).toMatchObject({
      field_type: 'CHECKBOX',
      label: 'Option A',
      group_key: 'g',
      group_rule: 'SELECT_ANY',
      min_selected: 2,
      y: 200,
    });
    expect(wire[3]).toEqual({
      envelope_document_id: 'd1',
      signer_id: 's1',
      field_type: 'ACKNOWLEDGEMENT',
      page_number: 0,
      x: 300,
      y: 300,
      width: 18,
      height: 18,
      required: true,
    });
    for (const f of wire) expect(f).not.toHaveProperty('value');
    // Config never rides on a type it does not apply to.
    expect(wire[3]).not.toHaveProperty('name_mode');
    expect(wire[0]).not.toHaveProperty('label');
  });

  it('a Name field defaults to the signer profile on the wire; a preserved field of a removed recipient is not re-sent', () => {
    const wire = fieldsToWire({
      ...payload,
      fields: [{ ...payload.fields[0]!, nameMode: undefined }],
      recipients: payload.recipients,
    });
    expect(wire[0]).toMatchObject({ name_mode: 'SIGNER_PROFILE' });
    const gone = fieldsToWire({
      ...payload,
      fields: [],
      recipients: [{ ...payload.recipients[0]!, serverId: 's9' }],
    });
    expect(gone).toEqual([]);
  });
});
