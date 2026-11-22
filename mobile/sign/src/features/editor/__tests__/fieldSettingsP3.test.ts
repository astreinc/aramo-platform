// FIELD-PARITY-1 P3 §6 — the app's sender editor: the settings each type shows (the catalog,
// the web editor's rule), the reducer actions for the new settings (one undo step each), radio
// groups and "Add option", and the settings on the wire (fieldsToWire) both ways.
import {
  editableSettings,
  hasSettings,
  optionsWire,
  p3SettingsWire,
  senderValueIssue,
  settingsFromServer,
  settingsIssue,
} from '../fieldSettings';
import { editorReducer, groupMembers, initialEditorState, type EditorAction, type EditorState } from '../editorReducer';
import { PHASE3_TOOLS, isSelfSignFieldType, sendTools, toolFieldTypes } from '../fieldTypes';
import { parseEnvelope, payloadFromServer } from '../../send/draftModel';
import { fieldsToWire } from '../../send/syncDraft';

const PAGE = { width: 612, height: 792 };
const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);
const place = (s: EditorState, tool: Parameters<typeof editorReducer>[1] extends never ? never : string, key: string) =>
  run(
    s,
    { type: 'pickTool', tool: tool as never },
    { type: 'placeAt', key, docKey: 'd1', page: 0, pageSize: PAGE, center: { x: 306, y: 300 } },
  );

describe('the Phase 3 tools (send flow)', () => {
  it('the send row ends with the Phase 3 tools; Sign a document keeps its row', () => {
    expect(sendTools(toolFieldTypes()).slice(-6).map((x) => x.type)).toEqual(['DATE', 'DROPDOWN', 'RADIO', 'NUMBER', 'MULTILINE_TEXT', 'ACKNOWLEDGEMENT']);
    expect(PHASE3_TOOLS).toHaveLength(6);
    expect(isSelfSignFieldType('DROPDOWN')).toBe(false);
    expect(isSelfSignFieldType('TEXT')).toBe(true);
  });
});

describe('settings per type (fieldSettingsOf; sender-filled only while the server says so)', () => {
  it('each type shows its catalog settings', () => {
    expect(editableSettings('DROPDOWN', false)).toEqual(['label', 'tooltip', 'data_name', 'placeholder', 'font_size', 'options']);
    expect(editableSettings('DROPDOWN', true)).toContain('sender_filled');
    expect(editableSettings('RADIO', false)).toEqual(['label', 'group_key', 'group_rule', 'tooltip', 'data_name']);
    expect(editableSettings('ACKNOWLEDGEMENT', true)).toEqual(['label', 'tooltip', 'data_name']);
    expect(hasSettings('SIGNATURE', false)).toBe(true);
    expect(hasSettings('PAYMENT', false)).toBe(false);
  });

  it('the wire members: only set, only the settings the type takes, a value only when sender-filled', () => {
    expect(p3SettingsWire({ type: 'SIGNATURE', placeholder: 'x', tooltip: ' Sign here ' })).toEqual({ tooltip: 'Sign here' });
    expect(p3SettingsWire({ type: 'TEXT', validation: 'max_length', options: { max_length: 50 }, fontSize: 12, dataName: 'city' })).toEqual({
      validation: 'max_length',
      font_size: 12,
      data_name: 'city',
      options: { max_length: 50 },
    });
    expect(p3SettingsWire({ type: 'TEXT', senderValue: 'v' })).toEqual({});
    expect(p3SettingsWire({ type: 'TEXT', senderFilled: true, readOnly: true, senderValue: 'v' })).toEqual({ read_only: true, sender_filled: true, value: 'v' });
    expect(optionsWire('NUMBER', null, { format: 'money', currency: 'EUR', decimals: 2, min: 1 })).toEqual({ format: 'money', currency: 'EUR', decimals: 2 });
    expect(optionsWire('DROPDOWN', null, { choices: [{ value: '', label: ' A ' }, { value: '', label: '' }] })).toEqual({ choices: [{ value: 'A', label: 'A' }] });
  });

  it('the ONE settings rule: dropdown without choices, radio without group, bad data name, sender-filled while off', () => {
    expect(settingsIssue({ type: 'DROPDOWN' }, false)?.reason).toBe('dropdown_choices_invalid');
    expect(settingsIssue({ type: 'RADIO' }, false)?.reason).toBe('radio_group_required');
    expect(settingsIssue({ type: 'TEXT', dataName: 'Bad' }, false)?.reason).toBe('data_name_invalid');
    expect(settingsIssue({ type: 'TEXT', senderFilled: true }, false)?.reason).toBe('sender_filled_not_available');
    expect(settingsIssue({ type: 'TEXT', senderFilled: true }, true)).toBeNull();
    expect(senderValueIssue({ type: 'NUMBER', senderFilled: true, senderValue: 'abc' })).toBe('number_value_invalid');
    expect(senderValueIssue({ type: 'DATE', senderFilled: true, senderValue: '2026-02-30' })).toBe('date_value_invalid');
  });
});

describe('reducer — Phase 3 settings', () => {
  it('a new DROPDOWN has two choices; a new RADIO its own group and option text', () => {
    let s = place(initialEditorState([], 'r1'), 'DROPDOWN', 'dd');
    expect(s.fields[0]!.options?.choices).toHaveLength(2);
    expect(settingsIssue(s.fields[0]!, false)).toBeNull();
    s = place(s, 'RADIO', 'r1a');
    expect(s.fields[1]).toMatchObject({ type: 'RADIO', label: 'Option 1', groupKey: 'group-1', groupRule: 'SELECT_ONE' });
    s = place(s, 'RADIO', 'r2a');
    expect(s.fields[2]!.groupKey).toBe('group-2');
  });

  it('"Add option" adds a sibling below in the group, selected, one undo step', () => {
    const s = run(place(initialEditorState([], 'r1'), 'RADIO', 'a'), { type: 'addRadioOption', key: 'a', newKey: 'b', pageSize: PAGE });
    const [a, b] = s.fields;
    expect(b).toMatchObject({ key: 'b', type: 'RADIO', groupKey: a!.groupKey, label: 'Option 2', x: a!.x, y: a!.y + a!.height + 8 });
    expect(s.selected).toBe('b');
    expect(groupMembers(s.fields, a!.groupKey)).toHaveLength(2);
    expect(run(s, { type: 'undo' }).fields).toHaveLength(1);
    // A radio never leaves its group; the group shares required.
    expect(run(s, { type: 'setGroup', key: 'a', groupKey: null })).toBe(s);
    expect(run(s, { type: 'toggleRequired', key: 'a' }).fields.map((f) => f.required)).toEqual([true, true]);
    expect(run(s, { type: 'setGroupRule', key: 'a', rule: 'SELECT_ANY' })).toBe(s);
  });

  it('configure: applies only settings the type takes; one undo step; sender-filled off clears value and read-only', () => {
    let s = place(initialEditorState([], 'r1'), 'TEXT', 't');
    s = run(s, { type: 'configure', key: 't', patch: { placeholder: 'City', validation: 'email', fontSize: 12 } });
    expect(s.fields[0]).toMatchObject({ placeholder: 'City', validation: 'email', fontSize: 12 });
    const before = s.undo.length;
    s = run(s, { type: 'configure', key: 't', patch: { senderFilled: true, readOnly: true, senderValue: 'Paris' } });
    expect(s.undo.length).toBe(before + 1);
    s = run(s, { type: 'configure', key: 't', patch: { senderFilled: false } });
    expect(s.fields[0]).toMatchObject({ senderFilled: false, readOnly: false, senderValue: null });
    const sig = place(initialEditorState([], 'r1'), 'SIGNATURE', 'sg');
    expect(run(sig, { type: 'configure', key: 'sg', patch: { placeholder: 'x' } })).toBe(sig);
    // Label (S-1) on any type that takes it.
    expect(run(sig, { type: 'setLabel', key: 'sg', label: 'Buyer' }).fields[0]!.label).toBe('Buyer');
  });

  it('a radio group shares sender-filled; choosing one option clears the others', () => {
    let s = run(place(initialEditorState([], 'r1'), 'RADIO', 'a'), { type: 'addRadioOption', key: 'a', newKey: 'b', pageSize: PAGE });
    s = run(s, { type: 'configure', key: 'a', patch: { senderFilled: true } });
    expect(s.fields.every((f) => f.senderFilled === true)).toBe(true);
    s = run(s, { type: 'configure', key: 'a', patch: { senderValue: 'true' } }, { type: 'configure', key: 'b', patch: { senderValue: 'true' } });
    expect(s.fields.map((f) => f.senderValue)).toEqual(['false', 'true']);
  });
});

describe('draft wire — Phase 3 settings both ways', () => {
  const env = parseEnvelope({
    id: 'e1',
    subject: 'S',
    status: 'DRAFT',
    editable: true,
    revision: 3,
    sender_filled_fields_enabled: true,
    documents: [{ id: 'd1', title: 'Doc' }],
    recipients: [{ id: 's1', name: 'Ana', email: 'a@x.test', status: 'PENDING', signing_order: 1 }],
    fields: [
      { envelope_document_id: 'd1', signer_id: 's1', page_number: 0, x: 72, y: 100, width: 180, height: 22, required: false, field_type: 'DROPDOWN', label: 'Plan', placeholder: 'Pick', data_name: 'plan', options: { choices: [{ value: 'a', label: 'A' }] } },
      { envelope_document_id: 'd1', signer_id: 's1', page_number: 0, x: 72, y: 200, width: 18, height: 18, required: true, field_type: 'RADIO', label: 'Yes', group_key: 'g', group_rule: 'SELECT_ONE' },
      { envelope_document_id: 'd1', signer_id: 's1', page_number: 0, x: 72, y: 300, width: 120, height: 22, required: false, field_type: 'NUMBER', validation: 'number_range', font_size: 11, sender_filled: true, read_only: true, value: '12.50', options: { format: 'money', currency: 'USD', decimals: 2, min: 0 } },
      { id: 'f-eng', envelope_document_id: 'd1', signer_id: null, page_number: 0, x: 5, y: 6, width: null, height: null, required: true, field_type: 'ACKNOWLEDGEMENT', label: 'I agree' },
    ],
  });
  const { payload } = payloadFromServer(env, '"e1.3"', new Map([['d1', [PAGE]]]));

  it('loads every setting into the editor; an engine row with no recipient stays preserved', () => {
    expect(payload.senderFilledEnabled).toBe(true);
    expect(payload.fields.map((f) => f.type)).toEqual(['DROPDOWN', 'RADIO', 'NUMBER']);
    expect(payload.fields[0]).toMatchObject({ label: 'Plan', placeholder: 'Pick', dataName: 'plan', options: { choices: [{ value: 'a', label: 'A' }] } });
    expect(payload.fields[1]).toMatchObject({ label: 'Yes', groupKey: 'g', groupRule: 'SELECT_ONE' });
    expect(payload.fields[2]).toMatchObject({ validation: 'number_range', fontSize: 11, senderFilled: true, readOnly: true, senderValue: '12.50' });
    expect(payload.preservedFields?.map((f) => f.id)).toEqual(['f-eng']);
    expect(settingsFromServer({ tooltip: null, read_only: false })).toEqual({});
  });

  it('sends them back unchanged (and the preserved row with its setting)', () => {
    const wire = fieldsToWire(payload);
    expect(wire[0]).toMatchObject({ field_type: 'DROPDOWN', label: 'Plan', placeholder: 'Pick', data_name: 'plan', options: { choices: [{ value: 'a', label: 'A' }] } });
    expect(wire[1]).toMatchObject({ field_type: 'RADIO', label: 'Yes', group_key: 'g' });
    expect(wire[2]).toMatchObject({ field_type: 'NUMBER', validation: 'number_range', font_size: 11, sender_filled: true, read_only: true, value: '12.50', options: { format: 'money', currency: 'USD', decimals: 2, min: 0 } });
    expect(wire[3]).toMatchObject({ id: 'f-eng', field_type: 'ACKNOWLEDGEMENT', label: 'I agree', signer_id: null });
    expect(wire[0]).not.toHaveProperty('value');
  });
});
