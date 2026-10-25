import {
  UNDO_DEPTH,
  editorReducer,
  fieldAccessibilityLabel,
  initialEditorState,
  type EditorAction,
  type EditorState,
} from '../editorReducer';
import { AUTHORING_FIELD_TYPES, FIELD_TYPE_SPECS, isAuthoringFieldType } from '../fieldTypes';

const PAGE = { width: 612, height: 792 };
const run = (s: EditorState, ...actions: EditorAction[]) => actions.reduce(editorReducer, s);

function placed(tool: (typeof AUTHORING_FIELD_TYPES)[number] = 'SIGNATURE', key = 'f1') {
  return run(
    initialEditorState([], 'r1'),
    { type: 'pickTool', tool },
    { type: 'placeAt', key, docKey: 'd1', page: 0, pageSize: PAGE, center: { x: 306, y: 396 } },
  );
}

describe('the four authoring field types (C-13)', () => {
  it('is exactly SIGNATURE, INITIALS, SIGN_DATE and TEXT', () => {
    expect([...AUTHORING_FIELD_TYPES].sort()).toEqual([
      'INITIALS',
      'SIGNATURE',
      'SIGN_DATE',
      'TEXT',
    ]);
    expect(Object.keys(FIELD_TYPE_SPECS).sort()).toEqual([
      'INITIALS',
      'SIGNATURE',
      'SIGN_DATE',
      'TEXT',
    ]);
    for (const other of ['SIGNER_NAME', 'CHECKBOX', 'ACKNOWLEDGEMENT', 'NAME']) {
      expect(isAuthoringFieldType(other)).toBe(false);
    }
  });

  it('refuses to pick or load any other type', () => {
    const s = editorReducer(initialEditorState([], 'r1'), {
      type: 'pickTool',
      tool: 'CHECKBOX' as never,
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
          type: 'CHECKBOX' as never,
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
          type: 'TEXT',
          x: 0,
          y: 0,
          width: 50,
          height: 20,
          required: false,
        },
      ],
    });
    expect(loaded.fields.map((f) => f.key)).toEqual(['b']);
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

  it('starts every type except Text as required', () => {
    for (const tool of AUTHORING_FIELD_TYPES) {
      expect(placed(tool).fields[0]!.required).toBe(tool !== 'TEXT');
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
