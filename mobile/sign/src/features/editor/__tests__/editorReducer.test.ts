import { FEATURES } from '../../../config/features';
import {
  UNDO_DEPTH,
  editorReducer,
  fieldAccessibilityLabel,
  groupMembers,
  initialEditorState,
  nextGroupKey,
  type EditorAction,
  type EditorState,
} from '../editorReducer';
import {
  AUTHORING_FIELD_TYPES,
  FIELD_TYPE_SPECS,
  isAuthoringFieldType,
  toolFieldTypes,
} from '../fieldTypes';

const PAGE = { width: 612, height: 792 };
const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);

function placed(tool: (typeof AUTHORING_FIELD_TYPES)[number] = 'SIGNATURE', key = 'f1') {
  return run(
    initialEditorState([], 'r1'),
    { type: 'pickTool', tool },
    { type: 'placeAt', key, docKey: 'd1', page: 0, pageSize: PAGE, center: { x: 306, y: 396 } },
  );
}

describe('the authoring field types (C-13 + M-A6 §2.1)', () => {
  it('is the four base tools plus Name and Checkbox; ACKNOWLEDGEMENT stays engine-only', () => {
    expect([...AUTHORING_FIELD_TYPES].sort()).toEqual([
      'CHECKBOX',
      'INITIALS',
      'SIGNATURE',
      'SIGNER_NAME',
      'SIGN_DATE',
      'TEXT',
    ]);
    expect(Object.keys(FIELD_TYPE_SPECS).sort()).toEqual([...AUTHORING_FIELD_TYPES].sort());
    for (const other of ['ACKNOWLEDGEMENT', 'NAME', 'STAMP']) {
      expect(isAuthoringFieldType(other)).toBe(false);
    }
  });

  it('shows Name and Checkbox only behind FEATURES.extraFieldTypes (on in this build)', () => {
    expect(FEATURES.extraFieldTypes).toBe(true);
    expect(toolFieldTypes(false)).toEqual(['SIGNATURE', 'INITIALS', 'SIGN_DATE', 'TEXT']);
    expect(toolFieldTypes(true)).toEqual([
      'SIGNATURE',
      'INITIALS',
      'SIGN_DATE',
      'TEXT',
      'SIGNER_NAME',
      'CHECKBOX',
    ]);
    expect(toolFieldTypes()).toEqual(toolFieldTypes(true));
  });

  it('refuses to pick or load an engine-only type', () => {
    const s = editorReducer(initialEditorState([], 'r1'), {
      type: 'pickTool',
      tool: 'ACKNOWLEDGEMENT' as never,
    });
    expect(s.tool).toBeNull();
    const loaded = editorReducer(initialEditorState(), {
      type: 'load',
      activeRecipient: 'r1',
      fields: [
        {
          key: 'a',
          docKey: 'd1',
          page: 0,
          recipientKey: 'r1',
          type: 'ACKNOWLEDGEMENT' as never,
          x: 0,
          y: 0,
          width: 16,
          height: 16,
          required: true,
        },
        {
          key: 'b',
          docKey: 'd1',
          page: 0,
          recipientKey: 'r1',
          type: 'CHECKBOX',
          x: 0,
          y: 0,
          width: 18,
          height: 18,
          required: false,
        },
      ],
    });
    expect(loaded.fields.map((f) => f.key)).toEqual(['b']);
  });
});

describe('Name and Checkbox configuration (M-A6 §2)', () => {
  const box = (key: string, y: number, recipientKey = 'r1') => ({
    key,
    docKey: 'd1',
    page: 0,
    recipientKey,
    type: 'CHECKBOX' as const,
    x: 10,
    y,
    width: 18,
    height: 18,
    required: false,
    label: null,
    groupKey: null,
    groupRule: null,
    minSelected: null,
  });

  it('a new Name field defaults to the signer profile; the mode can change', () => {
    const s = placed('SIGNER_NAME');
    expect(s.fields[0]).toMatchObject({
      type: 'SIGNER_NAME',
      nameMode: 'SIGNER_PROFILE',
      required: true,
    });
    const t = editorReducer(s, { type: 'setNameMode', key: 'f1', mode: 'SIGNER_ENTERED' });
    expect(t.fields[0]!.nameMode).toBe('SIGNER_ENTERED');
    expect(t.undo).toHaveLength(s.undo.length + 1);
    // Name mode never applies to another type.
    const sig = placed('SIGNATURE');
    expect(editorReducer(sig, { type: 'setNameMode', key: 'f1', mode: 'SIGNER_ENTERED' })).toBe(
      sig,
    );
  });

  it('a new Checkbox starts optional with no label or group; the label is trimmed and capped', () => {
    const s = placed('CHECKBOX');
    expect(s.fields[0]).toMatchObject({
      type: 'CHECKBOX',
      required: false,
      label: null,
      groupKey: null,
    });
    const labelled = editorReducer(s, { type: 'setLabel', key: 'f1', label: '  I agree  ' });
    expect(labelled.fields[0]!.label).toBe('I agree');
    expect(
      editorReducer(labelled, { type: 'setLabel', key: 'f1', label: '   ' }).fields[0]!.label,
    ).toBeNull();
    const long = editorReducer(s, { type: 'setLabel', key: 'f1', label: 'x'.repeat(250) });
    expect(long.fields[0]!.label).toHaveLength(200);
  });

  it('groups: joining adopts the rule, minimum and required setting; one recipient per group', () => {
    let s = initialEditorState(
      [box('a', 10), box('b', 40), box('c', 70), box('z', 100, 'r2')],
      'r1',
    );
    const g = nextGroupKey(s.fields);
    expect(g).toBe('group-1');
    s = run(
      s,
      { type: 'setGroup', key: 'a', groupKey: g },
      { type: 'setGroupRule', key: 'a', rule: 'SELECT_ONE' },
      { type: 'toggleRequired', key: 'a' },
      { type: 'setGroup', key: 'b', groupKey: g },
    );
    expect(s.fields.find((f) => f.key === 'b')).toMatchObject({
      groupKey: g,
      groupRule: 'SELECT_ONE',
      required: true,
    });
    expect(nextGroupKey(s.fields)).toBe('group-2');
    // Another recipient's box cannot join.
    expect(editorReducer(s, { type: 'setGroup', key: 'z', groupKey: g })).toBe(s);
    // Required and the rule apply to the whole group.
    s = editorReducer(s, { type: 'toggleRequired', key: 'b' });
    expect(groupMembers(s.fields, g).map((f) => f.required)).toEqual([false, false]);
    s = editorReducer(s, { type: 'setGroupRule', key: 'b', rule: 'SELECT_ANY' });
    expect(groupMembers(s.fields, g).map((f) => f.groupRule)).toEqual(['SELECT_ANY', 'SELECT_ANY']);
  });

  it('min_selected: SELECT_ANY only, clamped to the group size, reset by SELECT_ONE and on leave', () => {
    let s = run(
      initialEditorState([box('a', 10), box('b', 40), box('c', 70)], 'r1'),
      { type: 'setGroup', key: 'a', groupKey: 'g' },
      { type: 'setGroup', key: 'b', groupKey: 'g' },
      { type: 'setGroup', key: 'c', groupKey: 'g' },
      { type: 'setMinSelected', key: 'a', min: 5 },
    );
    expect(groupMembers(s.fields, 'g').map((f) => f.minSelected)).toEqual([3, 3, 3]);
    s = editorReducer(s, { type: 'setGroup', key: 'c', groupKey: null });
    expect(s.fields.find((f) => f.key === 'c')).toMatchObject({
      groupKey: null,
      groupRule: null,
      minSelected: null,
    });
    expect(groupMembers(s.fields, 'g').map((f) => f.minSelected)).toEqual([2, 2]);
    s = editorReducer(s, { type: 'delete', key: 'b' });
    expect(groupMembers(s.fields, 'g').map((f) => f.minSelected)).toEqual([1]);
    s = run(
      s,
      { type: 'setGroup', key: 'c', groupKey: 'g' },
      { type: 'setMinSelected', key: 'a', min: 2 },
    );
    expect(groupMembers(s.fields, 'g').map((f) => f.minSelected)).toEqual([2, 2]);
    s = editorReducer(s, { type: 'setGroupRule', key: 'a', rule: 'SELECT_ONE' });
    expect(groupMembers(s.fields, 'g').map((f) => f.minSelected)).toEqual([null, null]);
    expect(editorReducer(s, { type: 'setMinSelected', key: 'a', min: 2 })).toBe(s);
  });

  it('reassigning a grouped box moves its whole group', () => {
    const s = run(
      initialEditorState([box('a', 10), box('b', 40)], 'r1'),
      { type: 'setGroup', key: 'a', groupKey: 'g' },
      { type: 'setGroup', key: 'b', groupKey: 'g' },
      { type: 'reassign', key: 'a', recipientKeys: ['r1', 'r2'] },
    );
    expect(s.fields.map((f) => f.recipientKey)).toEqual(['r2', 'r2']);
  });
});

describe('editor reducer', () => {
  it('places the picked tool centred on the tap, releases the tool and selects the field', () => {
    const s = placed();
    expect(s.tool).toBeNull();
    expect(s.selected).toBe('f1');
    expect(s.fields).toEqual([
      {
        key: 'f1',
        docKey: 'd1',
        page: 0,
        recipientKey: 'r1',
        type: 'SIGNATURE',
        x: 191,
        y: 371,
        width: 230,
        height: 50,
        required: true,
      },
    ]);
  });

  it('starts every type except Text and Checkbox as required', () => {
    for (const tool of AUTHORING_FIELD_TYPES) {
      expect(placed(tool).fields[0]!.required).toBe(tool !== 'TEXT' && tool !== 'CHECKBOX');
    }
  });

  it('places nothing without a tool or a signer', () => {
    const noTool = editorReducer(initialEditorState([], 'r1'), {
      type: 'placeAt',
      key: 'x',
      docKey: 'd1',
      page: 0,
      pageSize: PAGE,
      center: { x: 1, y: 1 },
    });
    expect(noTool.fields).toHaveLength(0);
    const noSigner = run(
      initialEditorState([], null),
      { type: 'pickTool', tool: 'TEXT' },
      {
        type: 'placeAtCenter',
        key: 'x',
        docKey: 'd1',
        page: 0,
        pageSize: PAGE,
      },
    );
    expect(noSigner.fields).toHaveLength(0);
  });

  it('places at the page centre (accessible placement)', () => {
    const s = run(
      initialEditorState([], 'r1'),
      { type: 'pickTool', tool: 'INITIALS' },
      {
        type: 'placeAtCenter',
        key: 'c',
        docKey: 'd1',
        page: 2,
        pageSize: PAGE,
      },
    );
    expect(s.fields[0]).toMatchObject({ page: 2, x: 276, y: 381, width: 60, height: 30 });
  });

  it('moves within the page (a drag is one undo step)', () => {
    let s = run(placed(), { type: 'beginGesture' });
    s = run(
      s,
      { type: 'moveTo', key: 'f1', to: { x: 10, y: 20 }, pageSize: PAGE },
      { type: 'moveTo', key: 'f1', to: { x: 9999, y: -50 }, pageSize: PAGE },
    );
    expect(s.fields[0]).toMatchObject({ x: 612 - 230, y: 0 });
    s = editorReducer(s, { type: 'undo' });
    expect(s.fields[0]).toMatchObject({ x: 191, y: 371 });
  });

  it('clamps resizing to the 14×12 minimum and the page edge', () => {
    let s = run(placed(), {
      type: 'resizeTo',
      key: 'f1',
      size: { width: 2, height: 2 },
      pageSize: PAGE,
    });
    expect(s.fields[0]).toMatchObject({ width: 14, height: 12 });
    s = run(s, {
      type: 'resizeTo',
      key: 'f1',
      size: { width: 5000, height: 5000 },
      pageSize: PAGE,
    });
    expect(s.fields[0]).toMatchObject({ x: 191, y: 371, width: 612 - 191, height: 792 - 371 });
  });

  it('nudges and grows with the accessible controls, clamped, one undo step each', () => {
    let s = run(placed(), { type: 'nudge', key: 'f1', dx: -4, dy: 4, pageSize: PAGE });
    expect(s.fields[0]).toMatchObject({ x: 187, y: 375 });
    s = run(s, { type: 'nudge', key: 'f1', dx: -9999, dy: 0, pageSize: PAGE });
    expect(s.fields[0]!.x).toBe(0);
    s = run(s, { type: 'grow', key: 'f1', dw: 4, dh: -100, pageSize: PAGE });
    expect(s.fields[0]).toMatchObject({ width: 234, height: 12 });
    s = run(s, { type: 'undo' }, { type: 'undo' }, { type: 'undo' });
    expect(s.fields[0]).toMatchObject({ x: 191, y: 371, width: 230, height: 50 });
  });

  it('reassigns to the next signer in order, cycling', () => {
    const keys = ['r1', 'r2', 'r3'];
    let s = placed();
    s = run(s, { type: 'reassign', key: 'f1', recipientKeys: keys });
    expect(s.fields[0]!.recipientKey).toBe('r2');
    s = run(
      s,
      { type: 'reassign', key: 'f1', recipientKeys: keys },
      { type: 'reassign', key: 'f1', recipientKeys: keys },
    );
    expect(s.fields[0]!.recipientKey).toBe('r1');
    // "One signer": nothing to reassign to.
    expect(
      run(placed(), { type: 'reassign', key: 'f1', recipientKeys: ['r1'] }).fields[0]!.recipientKey,
    ).toBe('r1');
  });

  it('toggles required / optional', () => {
    let s = run(placed(), { type: 'toggleRequired', key: 'f1' });
    expect(s.fields[0]!.required).toBe(false);
    s = run(s, { type: 'toggleRequired', key: 'f1' });
    expect(s.fields[0]!.required).toBe(true);
  });

  it('deletes and deselects; undo brings it back', () => {
    let s = run(placed(), { type: 'delete', key: 'f1' });
    expect(s.fields).toHaveLength(0);
    expect(s.selected).toBeNull();
    s = editorReducer(s, { type: 'undo' });
    expect(s.fields.map((f) => f.key)).toEqual(['f1']);
  });

  it('keeps at most 30 undo steps', () => {
    expect(UNDO_DEPTH).toBe(30);
    let s = placed();
    for (let i = 0; i < 40; i += 1) s = editorReducer(s, { type: 'toggleRequired', key: 'f1' });
    expect(s.undo).toHaveLength(30);
    for (let i = 0; i < 30; i += 1) s = editorReducer(s, { type: 'undo' });
    expect(s.undo).toHaveLength(0);
    // 41 recorded changes (place + 40 toggles); the oldest 11 fell off, so the field
    // is still there after undoing every remaining step.
    expect(s.fields).toHaveLength(1);
    expect(editorReducer(s, { type: 'undo' })).toBe(s);
  });

  it('drops the fields of removed recipients', () => {
    let s = run(
      placed(),
      { type: 'setRecipient', recipientKey: 'r2' },
      { type: 'pickTool', tool: 'TEXT' },
      {
        type: 'placeAt',
        key: 'f2',
        docKey: 'd1',
        page: 0,
        pageSize: PAGE,
        center: { x: 100, y: 100 },
      },
    );
    s = editorReducer(s, { type: 'recipientsChanged', recipientKeys: ['r1'] });
    expect(s.fields.map((f) => f.key)).toEqual(['f1']);
    expect(s.activeRecipient).toBe('r1');
  });

  it('announces "{Type}, for {signer}, {required|optional}, empty"', () => {
    expect(fieldAccessibilityLabel(placed().fields[0]!, 'Dana Lee')).toBe(
      'Signature, for Dana Lee, required, empty',
    );
    expect(fieldAccessibilityLabel(placed('TEXT').fields[0]!, 'Dana Lee')).toBe(
      'Text, for Dana Lee, optional, empty',
    );
  });
});
