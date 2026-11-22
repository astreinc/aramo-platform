import { describe, expect, it } from 'vitest';

import {
  HISTORY_LIMIT,
  applyChanges,
  assignField,
  configureField,
  diffFields,
  editorReducer,
  initialEditorState,
  nudgeFields,
  placeField,
  removeFields,
  resizeFields,
  roundGestureBox,
  type CommandContext,
  type EditorAction,
  type EditorState,
} from './editor-state';
import { DEFAULT_SETTINGS, type PlacedField } from './model';

// FIELD-PARITY-1 P1-5 — the shared editor's state model: commands, the invertible history
// (undo, and the Phase 2 redo kept in the reducer), gestures, the selection set.

const LETTER = { width: 612, height: 792 };
const A4 = { width: 595.28, height: 841.89 };
const ctx = (precision: CommandContext['precision'] = 'integer'): CommandContext => ({
  precision,
  pageSize: (ref) => (ref.docId === 'a4' ? A4 : ref.docId === 'd1' ? LETTER : undefined),
});

const field = (id: string, over: Partial<PlacedField> = {}): PlacedField => ({
  id,
  type: 'TEXT',
  docId: 'd1',
  page: 0,
  x: 100,
  y: 500,
  width: 230,
  height: 22,
  required: false,
  assignee: 's1',
  binding: null,
  settings: DEFAULT_SETTINGS,
  ...over,
});

function run(state: EditorState, ...actions: EditorAction[]): EditorState {
  return actions.reduce((s, a) => editorReducer(s, a, ctx()), state);
}

describe('commands', () => {
  it('place adds; delete removes (a locked field may be deleted)', () => {
    let s = run(initialEditorState([field('a')]), { type: 'exec', command: placeField(field('b')) });
    expect(s.fields.map((f) => f.id)).toEqual(['a', 'b']);
    s = run(initialEditorState([field('a', { locked: true })]), { type: 'exec', command: removeFields(['a']) });
    expect(s.fields).toEqual([]);
  });

  it('nudge moves in the top-left frame (down lowers the PDF y), clamped to the page; locked fields never move', () => {
    const s = run(initialEditorState([field('a'), field('k', { locked: true })]), { type: 'exec', command: nudgeFields(['a', 'k'], 2, 10) });
    expect(s.fields[0]).toMatchObject({ x: 102, y: 490 });
    expect(s.fields[1]).toMatchObject({ x: 100, y: 500 });
    const edge = run(initialEditorState([field('a', { x: 0, y: 0 })]), { type: 'exec', command: nudgeFields(['a'], -10, 10) });
    expect(edge.fields[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('resize keeps the top-left corner and the 14pt minimum', () => {
    const s = run(initialEditorState([field('a')]), { type: 'exec', command: resizeFields(['a'], 10, 2) });
    // Top edge (792 - 500 - 22 = 270) stays; height grows downwards → y drops by 2.
    expect(s.fields[0]).toMatchObject({ x: 100, y: 498, width: 240, height: 24 });
    const min = run(initialEditorState([field('a')]), { type: 'exec', command: resizeFields(['a'], -500, -500) });
    expect(min.fields[0]).toMatchObject({ width: 14, height: 14 });
  });

  it('required toggle and settings edits go through the check-box group rules', () => {
    const fields = [field('a', { type: 'CHECKBOX', settings: { ...DEFAULT_SETTINGS, groupKey: 'g' } }), field('b', { type: 'CHECKBOX', settings: { ...DEFAULT_SETTINGS, groupKey: 'g' } })];
    let s = run(initialEditorState(fields), { type: 'exec', command: configureField('a', { required: true }) });
    expect(s.fields.map((f) => f.required)).toEqual([true, true]);
    s = run(s, { type: 'exec', command: configureField('b', { groupRule: 'SELECT_ONE' }) });
    expect(s.fields.map((f) => f.settings.groupRule)).toEqual(['SELECT_ONE', 'SELECT_ONE']);
    s = run(s, { type: 'exec', command: configureField('a', { label: 'Yes' }) });
    expect(s.fields[0]?.settings.label).toBe('Yes');
    // A locked field's settings never change.
    const locked = run(initialEditorState([field('k', { locked: true })]), { type: 'exec', command: configureField('k', { required: true }) });
    expect(locked.past).toHaveLength(0);
  });

  it('reassign: to another recipient / role, or (console) to a prefill variable', () => {
    let s = run(initialEditorState([field('a')]), { type: 'exec', command: assignField('a', { assignee: 's2', binding: null }) });
    expect(s.fields[0]).toMatchObject({ assignee: 's2', binding: null });
    s = run(s, { type: 'exec', command: assignField('a', { assignee: null, binding: 'organization.name' }) });
    expect(s.fields[0]).toMatchObject({ assignee: null, binding: 'organization.name' });
  });
});

describe('history', () => {
  it('undo replays each command backwards, restoring order; redo replays it forwards', () => {
    const s0 = initialEditorState([field('a'), field('b'), field('c')]);
    const s1 = run(s0, { type: 'exec', command: removeFields(['b']) }, { type: 'exec', command: nudgeFields(['c'], 10, 0) });
    expect(s1.fields.map((f) => f.id)).toEqual(['a', 'c']);
    const u1 = run(s1, { type: 'undo' });
    expect(u1.fields.find((f) => f.id === 'c')?.x).toBe(100);
    expect(u1.lastUndo).toBe('Move field');
    const u2 = run(u1, { type: 'undo' });
    expect(u2.fields.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(u2.fields).toEqual(s0.fields);
    const r = run(u2, { type: 'redo' }, { type: 'redo' });
    expect(r.fields).toEqual(s1.fields);
    // A new command clears the redo stack.
    const n = run(u2, { type: 'exec', command: placeField(field('d')) });
    expect(n.future).toHaveLength(0);
  });

  it('a no-op command records nothing; history keeps the last HISTORY_LIMIT entries', () => {
    const s = run(initialEditorState([field('a', { x: 0 })]), { type: 'exec', command: nudgeFields(['a'], -2, 0) });
    expect(s.past).toHaveLength(0);
    expect(s.rev).toBe(0);
    let t = initialEditorState([field('a')]);
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) t = run(t, { type: 'exec', command: nudgeFields(['a'], 0, 2) });
    expect(t.past).toHaveLength(HISTORY_LIMIT);
  });

  it('diff / apply are inverses', () => {
    const before = [field('a'), field('b'), field('c')];
    const after = [field('a', { x: 9 }), field('c'), field('d')];
    const changes = diffFields(before, after);
    expect(applyChanges(after, changes, 'before')).toEqual(before);
    expect(applyChanges(before, changes, 'after')).toEqual(after);
  });

  it('a reset is not an edit (rev is kept) and clears the history', () => {
    const s = run(initialEditorState([field('a')]), { type: 'exec', command: nudgeFields(['a'], 2, 0) });
    const r = run(s, { type: 'reset', fields: [field('z')] });
    expect(r.rev).toBe(s.rev);
    expect(r.past).toHaveLength(0);
    expect(r.fields.map((f) => f.id)).toEqual(['z']);
  });
});

describe('gestures and selection', () => {
  it('a drag updates live without history and records ONE entry when it ends', () => {
    let s = run(initialEditorState([field('a')]), { type: 'gesture-start' });
    s = run(s, { type: 'gesture-move', id: 'a', mode: 'move', dx: 5.4, dy: 0 }, { type: 'gesture-move', id: 'a', mode: 'move', dx: 10.6, dy: -20.2 });
    expect(s.past).toHaveLength(0);
    // integer precision rounds the top-left box: x 110.6 → 111; top 270 - 20.2 → 250 → y 520.
    expect(s.fields[0]).toMatchObject({ x: 111, y: 520 });
    s = run(s, { type: 'gesture-end', label: 'Move field' });
    expect(s.past).toHaveLength(1);
    expect(run(s, { type: 'undo' }).fields[0]).toMatchObject({ x: 100, y: 500 });
  });

  it('a click without movement records nothing; a locked field is not dragged', () => {
    const s = run(initialEditorState([field('a'), field('k', { locked: true })]), { type: 'gesture-start' }, { type: 'gesture-move', id: 'k', mode: 'move', dx: 30, dy: 30 }, { type: 'gesture-end', label: 'Move field' });
    expect(s.past).toHaveLength(0);
    expect(s.fields[1]).toMatchObject({ x: 100, y: 500 });
  });

  it('resize gesture and the two hosts’ rounding rules', () => {
    const s = run(initialEditorState([field('a')]), { type: 'gesture-start' }, { type: 'gesture-move', id: 'a', mode: 'resize', dx: 10.4, dy: 3.6 });
    expect(s.fields[0]).toMatchObject({ width: 240, height: 26 });
    // Console: PDF-native, hundredths.
    expect(roundGestureBox({ x: 10.123, y: 20.456, width: 100.005, height: 30 }, A4, 'hundredths')).toEqual({ x: 10.12, y: 791.43, width: 100.01, height: 30 });
    // sign-web: the top-left box in whole points.
    expect(roundGestureBox({ x: 10.4, y: 20.6, width: 100.2, height: 29.7 }, LETTER, 'integer')).toEqual({ x: 10, y: 792 - 21 - 30, width: 100, height: 30 });
  });

  it('the selection is a set of ids, pruned when fields go away', () => {
    let s = run(initialEditorState([field('a'), field('b')]), { type: 'select', ids: ['a', 'b', 'nope'] });
    expect(s.selection).toEqual(['a', 'b']);
    s = run(s, { type: 'exec', command: removeFields(['a']) });
    expect(s.selection).toEqual(['b']);
  });
});
