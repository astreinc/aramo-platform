import { describe, expect, it } from 'vitest';

import {
  HISTORY_LIMIT,
  alignFields,
  applyChanges,
  assignField,
  assignFields,
  distributeFields,
  placeFields,
  sameSizeFields,
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

// ---- FIELD-PARITY-1 §5 P2-1..P2-3 ---------------------------------------------------------

/** Run a command, then check undo restores the start and redo restores the result (one entry). */
function roundTrip(start: EditorState, action: EditorAction): EditorState {
  const done = run(start, action);
  expect(done.past).toHaveLength(start.past.length + 1);
  const undone = run(done, { type: 'undo' });
  expect(undone.fields).toEqual(start.fields);
  const redone = run(undone, { type: 'redo' });
  expect(redone.fields).toEqual(done.fields);
  expect(redone.lastRedo).toBe(done.past[done.past.length - 1]!.label);
  expect(redone.lastUndo).toBeNull();
  return done;
}

describe('P2 many-field commands (each one undo step, undo and redo)', () => {
  it('placeFields adds many as one step (Repeat down of 9 rows = 1 undo)', () => {
    const rows = Array.from({ length: 9 }, (_, i) => field(`r${i}`, { y: 500 - 30 * (i + 1) }));
    const s = roundTrip(initialEditorState([field('a')]), { type: 'exec', command: placeFields(rows, 'Repeat down 9 rows') });
    expect(s.fields).toHaveLength(10);
    expect(s.past[0]!.label).toBe('Repeat down 9 rows');
  });

  it('assignFields reassigns many; locked fields keep theirs', () => {
    const s = roundTrip(initialEditorState([field('a'), field('b'), field('k', { locked: true })]), { type: 'exec', command: assignFields(['a', 'b', 'k'], { assignee: 's2', binding: null }) });
    expect(s.fields.map((f) => f.assignee)).toEqual(['s2', 's2', 's1']);
  });

  it('removeFields deletes many as one step', () => {
    const s = roundTrip(initialEditorState([field('a'), field('b'), field('c')]), { type: 'exec', command: removeFields(['a', 'c'], 'Delete 2 fields') });
    expect(s.fields.map((f) => f.id)).toEqual(['b']);
  });

  it('nudge and resize act on every selected field; a group stops together at the page edge', () => {
    const start = initialEditorState([field('a', { x: 4 }), field('b', { x: 300 })]);
    const s = roundTrip(start, { type: 'exec', command: nudgeFields(['a', 'b'], -10, 0) });
    expect(s.fields.map((f) => f.x)).toEqual([0, 296]);
    const r = roundTrip(start, { type: 'exec', command: resizeFields(['a', 'b'], 10, 0) });
    expect(r.fields.map((f) => f.width)).toEqual([240, 240]);
  });

  it.each([
    ['left', 'x', [100, 100]],
    ['right', 'x', [100, 270]],
    ['hcenter', 'x', [100, 185]],
    ['top', 'y', [500, 500]],
    ['bottom', 'y', [400, 400]],
    ['vcenter', 'y', [450, 450]],
  ] as const)('align %s (top-left maths, stored PDF-native)', (edge, axis, want) => {
    // a: x 100..330, top 270; b: x 200..260, top 370 (both 22 high).
    const a = field('a', { x: 100, y: 500, width: 230, height: 22 });
    const b = field('b', { x: 200, y: 400, width: 60, height: 22 });
    const s = roundTrip(initialEditorState([a, b]), { type: 'exec', command: alignFields(['a', 'b'], edge) });
    expect(s.fields.map((f) => f[axis])).toEqual(want);
  });

  it('align leaves locked fields and fields on other pages alone; a lone field per page does not move', () => {
    const s = run(initialEditorState([field('a', { x: 50 }), field('k', { x: 10, locked: true }), field('p', { x: 5, page: 1 })]), { type: 'exec', command: alignFields(['a', 'k', 'p'], 'left') });
    expect(s.fields.map((f) => f.x)).toEqual([50, 10, 5]);
    expect(s.past).toHaveLength(0);
  });

  it('distribute equalises gaps; hundredths rounding on the console', () => {
    const fs = [field('a', { x: 0, width: 10 }), field('b', { x: 13, width: 10 }), field('c', { x: 100, width: 10 })];
    const s = roundTrip(initialEditorState(fs), { type: 'exec', command: distributeFields(['a', 'b', 'c'], 'horizontal') });
    expect(s.fields.map((f) => f.x)).toEqual([0, 50, 100]);
    const v = [field('a', { y: 700, height: 20 }), field('b', { y: 650, height: 20 }), field('c', { y: 100, height: 20 })];
    const t = editorReducer(initialEditorState(v), { type: 'exec', command: distributeFields(['a', 'b', 'c'], 'vertical') }, ctx('hundredths'));
    expect(t.fields.map((f) => f.y)).toEqual([700, 400, 100]);
  });

  it('same width / height copy the first id (the anchor); top-left corners stay', () => {
    const fs = [field('a', { width: 100, height: 30 }), field('b', { width: 50, height: 22 })];
    const w = roundTrip(initialEditorState(fs), { type: 'exec', command: sameSizeFields(['a', 'b'], 'width') });
    expect(w.fields.map((f) => f.width)).toEqual([100, 100]);
    const h = roundTrip(initialEditorState(fs), { type: 'exec', command: sameSizeFields(['b', 'a'], 'height') });
    // a's top (792 - 500 - 30 = 262) stays; its height becomes 22 → y = 792 - 262 - 22 = 508.
    expect(h.fields[0]).toMatchObject({ height: 22, y: 508 });
  });
});

describe('P2 gestures: many fields, snap and guides', () => {
  it('dragging one field of a selection moves the selection as ONE undo step', () => {
    let s = run(initialEditorState([field('a'), field('b', { x: 300 }), field('c', { x: 10 })]), { type: 'gesture-start' });
    s = run(s, { type: 'gesture-move', id: 'a', ids: ['a', 'b'], mode: 'move', dx: 20, dy: 0 }, { type: 'gesture-end', label: 'Move 2 fields' });
    expect(s.fields.map((f) => f.x)).toEqual([120, 320, 10]);
    expect(s.past).toHaveLength(1);
    const u = run(s, { type: 'undo' });
    expect(u.fields.map((f) => f.x)).toEqual([100, 300, 10]);
    expect(run(u, { type: 'redo' }).fields.map((f) => f.x)).toEqual([120, 320, 10]);
  });

  it('a group drag keeps its shape at the page edge', () => {
    const s = run(initialEditorState([field('a', { x: 300 }), field('b', { x: 350 })]), { type: 'gesture-start' }, { type: 'gesture-move', id: 'a', ids: ['a', 'b'], mode: 'move', dx: 500, dy: 0 });
    // b's right edge stops at 612 → dx 32; a moves the same.
    expect(s.fields.map((f) => f.x)).toEqual([332, 382]);
  });

  it('snaps to another field’s edge and leaves a guide; Shift (no snap) does not; gesture end clears the guides', () => {
    const fs = [field('a', { x: 100, y: 500 }), field('t', { x: 50, y: 300 })];
    const snap = { edges: true, grid: null, threshold: 5 };
    let s = run(initialEditorState(fs), { type: 'gesture-start' }, { type: 'gesture-move', id: 'a', mode: 'move', dx: -47, dy: -150, snap });
    expect(s.fields[0]).toMatchObject({ x: 50 });
    expect(s.guides).toMatchObject({ docId: 'd1', page: 0 });
    expect(s.guides!.xs).toContain(50);
    const free = run(initialEditorState(fs), { type: 'gesture-start' }, { type: 'gesture-move', id: 'a', mode: 'move', dx: -47, dy: -150, snap: null });
    expect(free.fields[0]).toMatchObject({ x: 53 });
    expect(free.guides).toBeNull();
    s = run(s, { type: 'gesture-end', label: 'Move field' });
    expect(s.guides).toBeNull();
  });

  it('the grid snaps the top-left corner; resize snaps the right edge to another field', () => {
    const g = run(initialEditorState([field('a', { x: 100, y: 500 })]), { type: 'gesture-start' }, { type: 'gesture-move', id: 'a', mode: 'move', dx: 3, dy: 0, snap: { edges: false, grid: 10, threshold: 5 } });
    expect(g.fields[0]!.x).toBe(100);
    const r = run(initialEditorState([field('a', { x: 100, width: 100 }), field('t', { x: 50, y: 300, width: 155 })]), { type: 'gesture-start' }, { type: 'gesture-move', id: 'a', mode: 'resize', dx: 3, dy: 0, snap: { edges: true, grid: null, threshold: 5 } });
    expect(r.fields[0]!.width).toBe(105);
    expect(r.guides!.xs).toEqual([205]);
  });
});
