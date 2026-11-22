// FIELD-PARITY-1 P1-5 — the placement editor's state: the fields, the selection (a SET of ids,
// so Phase 2 multi-select needs no new model) and a command-based history. Every edit is a
// Command (a named, pure fields → fields step); the reducer records each executed command as
// an invertible diff, so undo replays the diff backwards and redo (kept in the reducer for
// Phase 2 P2-3, not yet offered in the UI) replays it forwards. A pointer gesture (drag, resize)
// updates live without history and is recorded as ONE entry when it ends.

import { clampBox, toPdf, toTopLeft, type Box, type PdfPageInfo } from './geometry';
import { type PageRef, type PlacedField } from './model';
import { applySettings, type SettingsPatch } from './settings';

/** sign-web Prepare's undo depth (PrepareEditor.tsx before P1-5: 20). */
export const HISTORY_LIMIT = 20;

/**
 * How a pointer gesture rounds the box it produces — each host's existing rule, so saved
 * values keep their meaning: sign-web rounds the top-left box to whole points; the console
 * rounds the PDF-native box to hundredths of a point.
 */
export type DragPrecision = 'integer' | 'hundredths';

export interface CommandContext {
  readonly pageSize: (ref: PageRef) => PdfPageInfo | undefined;
  readonly precision: DragPrecision;
}

export interface Command {
  /** What the history entry is called (announced on undo). */
  readonly label: string;
  readonly run: (fields: readonly PlacedField[], ctx: CommandContext) => PlacedField[];
}

export interface FieldChange {
  readonly id: string;
  readonly before: { readonly field: PlacedField; readonly index: number } | null;
  readonly after: { readonly field: PlacedField; readonly index: number } | null;
}

export interface HistoryEntry {
  readonly label: string;
  readonly changes: readonly FieldChange[];
}

export interface EditorState {
  readonly fields: readonly PlacedField[];
  /** The selected field ids (Phase 1 selects one at a time; the set is Phase 2-ready). */
  readonly selection: readonly string[];
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly gesture: { readonly before: readonly PlacedField[] } | null;
  /** Bumped by every user edit (not by a reset): what a host's autosave watches. */
  readonly rev: number;
  /** The label of the last undone / redone entry (for the live announcement). */
  readonly lastUndo: string | null;
}

export type EditorAction =
  | { readonly type: 'reset'; readonly fields: readonly PlacedField[] }
  | { readonly type: 'select'; readonly ids: readonly string[] }
  | { readonly type: 'exec'; readonly command: Command }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'gesture-start' }
  | { readonly type: 'gesture-move'; readonly id: string; readonly mode: 'move' | 'resize'; readonly dx: number; readonly dy: number }
  | { readonly type: 'gesture-end'; readonly label: string };

export function initialEditorState(fields: readonly PlacedField[]): EditorState {
  return { fields: [...fields], selection: [], past: [], future: [], gesture: null, rev: 0, lastUndo: null };
}

/** The changes between two field lists (by id, with each side's index). */
export function diffFields(before: readonly PlacedField[], after: readonly PlacedField[]): FieldChange[] {
  const b = new Map(before.map((field, index) => [field.id, { field, index }]));
  const a = new Map(after.map((field, index) => [field.id, { field, index }]));
  const out: FieldChange[] = [];
  for (const id of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(id) ?? null;
    const y = a.get(id) ?? null;
    if (x !== null && y !== null && x.field === y.field && x.index === y.index) continue;
    out.push({ id, before: x, after: y });
  }
  return out;
}

/** Replays one side of a history entry onto the current fields. */
export function applyChanges(fields: readonly PlacedField[], changes: readonly FieldChange[], side: 'before' | 'after'): PlacedField[] {
  const ids = new Set(changes.map((c) => c.id));
  const out = fields.filter((f) => !ids.has(f.id));
  const ins = changes.flatMap((c) => (c[side] === null ? [] : [c[side]!])).sort((x, y) => x.index - y.index);
  for (const e of ins) out.splice(Math.min(e.index, out.length), 0, e.field);
  return out;
}

const keepSelection = (sel: readonly string[], fields: readonly PlacedField[]): string[] => sel.filter((id) => fields.some((f) => f.id === id));

function record(state: EditorState, label: string, before: readonly PlacedField[], after: PlacedField[]): EditorState {
  const changes = diffFields(before, after);
  if (changes.length === 0) return state.fields === before ? state : { ...state, fields: after };
  return {
    ...state,
    fields: after,
    selection: keepSelection(state.selection, after),
    past: [...state.past, { label, changes }].slice(-HISTORY_LIMIT),
    future: [],
    rev: state.rev + 1,
    lastUndo: null,
  };
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** A box produced by a gesture, rounded by the host's rule, back in the PDF-native frame. */
export function roundGestureBox(tl: Box, page: PdfPageInfo, precision: DragPrecision): Box {
  if (precision === 'integer') {
    return toPdf({ x: Math.round(tl.x), y: Math.round(tl.y), width: Math.round(tl.width), height: Math.round(tl.height) }, page.height);
  }
  const b = toPdf(tl, page.height);
  return { x: r2(b.x), y: r2(b.y), width: r2(b.width), height: r2(b.height) };
}

const boxOf = (f: PlacedField): Box => ({ x: f.x, y: f.y, width: f.width, height: f.height });
const withBox = (f: PlacedField, b: Box): PlacedField =>
  b.x === f.x && b.y === f.y && b.width === f.width && b.height === f.height ? f : { ...f, x: b.x, y: b.y, width: b.width, height: b.height };

export function editorReducer(state: EditorState, action: EditorAction, ctx: CommandContext): EditorState {
  switch (action.type) {
    case 'reset':
      // Not an edit: rev is kept so a host's autosave does not fire.
      return { ...initialEditorState(action.fields), rev: state.rev };
    case 'select': {
      const ids = keepSelection(action.ids, state.fields);
      return ids.length === state.selection.length && ids.every((id, i) => state.selection[i] === id) ? state : { ...state, selection: ids };
    }
    case 'exec':
      return record(state, action.command.label, state.fields, action.command.run(state.fields, ctx));
    case 'undo': {
      const entry = state.past[state.past.length - 1];
      if (entry === undefined) return state;
      const fields = applyChanges(state.fields, entry.changes, 'before');
      return { ...state, fields, selection: keepSelection(state.selection, fields), past: state.past.slice(0, -1), future: [...state.future, entry], rev: state.rev + 1, lastUndo: entry.label };
    }
    case 'redo': {
      const entry = state.future[state.future.length - 1];
      if (entry === undefined) return state;
      const fields = applyChanges(state.fields, entry.changes, 'after');
      return { ...state, fields, selection: keepSelection(state.selection, fields), past: [...state.past, entry], future: state.future.slice(0, -1), rev: state.rev + 1, lastUndo: entry.label };
    }
    case 'gesture-start':
      return { ...state, gesture: { before: state.fields } };
    case 'gesture-move': {
      const origin = state.gesture?.before.find((f) => f.id === action.id);
      if (origin === undefined || origin.locked === true) return state;
      const page = ctx.pageSize({ docId: origin.docId, page: origin.page });
      if (page === undefined) return state;
      const tl = toTopLeft(boxOf(origin), page.height);
      const moved =
        action.mode === 'move'
          ? clampBox({ ...tl, x: tl.x + action.dx, y: tl.y + action.dy }, page)
          : clampBox({ ...tl, width: tl.width + action.dx, height: tl.height + action.dy }, page);
      const box = roundGestureBox(moved, page, ctx.precision);
      const fields = state.fields.map((f) => (f.id === action.id ? withBox(f, box) : f));
      return { ...state, fields, rev: fields.some((f, i) => f !== state.fields[i]) ? state.rev + 1 : state.rev };
    }
    case 'gesture-end': {
      const g = state.gesture;
      if (g === null) return state;
      const done = { ...state, gesture: null };
      const changes = diffFields(g.before, state.fields);
      if (changes.length === 0) return done;
      return { ...done, past: [...state.past, { label: action.label, changes }].slice(-HISTORY_LIMIT), future: [], lastUndo: null };
    }
  }
}

// ---- Commands -------------------------------------------------------------------------------

const editable = (f: PlacedField): boolean => f.locked !== true;

/** Place a new field (already sized and positioned by the caller). */
export function placeField(field: PlacedField, label = 'Add field'): Command {
  return { label, run: (fields) => [...fields, field] };
}

/** Delete fields (a locked field may be deleted). */
export function removeFields(ids: readonly string[], label = 'Delete field'): Command {
  const set = new Set(ids);
  return { label, run: (fields) => fields.filter((f) => !set.has(f.id)) };
}

/** Keyboard move by (dx, dy) points in the top-left frame (down = +dy), kept inside the page. */
export function nudgeFields(ids: readonly string[], dx: number, dy: number, label = 'Move field'): Command {
  const set = new Set(ids);
  return {
    label,
    run: (fields, ctx) =>
      fields.map((f) => {
        if (!set.has(f.id) || !editable(f)) return f;
        const page = ctx.pageSize({ docId: f.docId, page: f.page });
        if (page === undefined) return f;
        const tl = toTopLeft(boxOf(f), page.height);
        return withBox(f, toPdf(clampBox({ ...tl, x: tl.x + dx, y: tl.y + dy }, page), page.height));
      }),
  };
}

/** Keyboard resize by (dw, dh) points (the top-left corner stays), kept inside the page. */
export function resizeFields(ids: readonly string[], dw: number, dh: number, label = 'Resize field'): Command {
  const set = new Set(ids);
  return {
    label,
    run: (fields, ctx) =>
      fields.map((f) => {
        if (!set.has(f.id) || !editable(f)) return f;
        const page = ctx.pageSize({ docId: f.docId, page: f.page });
        if (page === undefined) return f;
        const tl = toTopLeft(boxOf(f), page.height);
        return withBox(f, toPdf(clampBox({ ...tl, width: tl.width + dw, height: tl.height + dh }, page), page.height));
      }),
  };
}

/** Who fills a field: a recipient / role, or (console) a template variable. */
export function assignField(id: string, to: { readonly assignee: string | null; readonly binding: string | null }, label = 'Change who fills the field'): Command {
  return {
    label,
    run: (fields) => fields.map((f) => (f.id === id && editable(f) && (f.assignee !== to.assignee || f.binding !== to.binding) ? { ...f, assignee: to.assignee, binding: to.binding } : f)),
  };
}

/** An inspector change (required and the settings), keeping check-box groups consistent. */
export function configureField(id: string, patch: SettingsPatch, label = 'Change field settings'): Command {
  return {
    label,
    run: (fields) => {
      const target = fields.find((f) => f.id === id);
      if (target === undefined || !editable(target)) return [...fields];
      // applySettings returns fresh objects; keep identity for unchanged fields so history
      // records only real changes.
      const next = applySettings(fields, id, patch);
      return next.map((f, i) => {
        const o = fields[i]!;
        return f.required === o.required && JSON.stringify(f.settings) === JSON.stringify(o.settings) ? o : f;
      });
    },
  };
}
