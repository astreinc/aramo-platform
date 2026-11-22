// FIELD-PARITY-1 P1-5 — the placement editor's state: the fields, the selection (a SET of ids)
// and a command-based history. Every edit is a Command (a named, pure fields → fields step);
// the reducer records each executed command as an invertible diff, so undo replays the diff
// backwards and redo replays it forwards. A pointer gesture (drag, resize) updates live without
// history and is recorded as ONE entry when it ends.
//
// P2 (§5 P2-1..P2-3): many-field commands (add many, reassign, align, distribute, same size);
// a gesture moves or resizes every selected field and may snap to other fields' edges or the
// grid, leaving the guide lines to draw in `guides`; redo is offered by the editor.

import { alignBoxes, clampGroupDelta, distributeBoxes, sameSizeBoxes, snapMove, snapResize, type AlignEdge, type Axis, type Dimension, type SnapOptions } from './arrange';
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
  /** The selected field ids; the first is the anchor (same width / height copies it). */
  readonly selection: readonly string[];
  readonly past: readonly HistoryEntry[];
  readonly future: readonly HistoryEntry[];
  readonly gesture: { readonly before: readonly PlacedField[] } | null;
  /** Bumped by every user edit (not by a reset): what a host's autosave watches. */
  readonly rev: number;
  /** The label of the last undone entry (for the live announcement). */
  readonly lastUndo: string | null;
  /** The label of the last redone entry (for the live announcement). */
  readonly lastRedo: string | null;
  /** P2-3 — the alignment guides of the gesture in progress (null when none). */
  readonly guides: PageGuides | null;
}

/** Guide lines on one page, in its top-left frame (points). */
export interface PageGuides extends PageRef {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
}

export type EditorAction =
  | { readonly type: 'reset'; readonly fields: readonly PlacedField[] }
  | { readonly type: 'select'; readonly ids: readonly string[] }
  | { readonly type: 'exec'; readonly command: Command }
  | { readonly type: 'undo' }
  | { readonly type: 'redo' }
  | { readonly type: 'gesture-start' }
  | {
      readonly type: 'gesture-move';
      /** The field under the pointer (its box is what snaps). */
      readonly id: string;
      /** Every field the gesture moves or resizes (default: just `id`). */
      readonly ids?: readonly string[];
      readonly mode: 'move' | 'resize';
      readonly dx: number;
      readonly dy: number;
      /** Snap (P2-3); null or absent = no snapping (Shift held, or snapping off). */
      readonly snap?: SnapOptions | null;
    }
  | { readonly type: 'gesture-end'; readonly label: string };

export function initialEditorState(fields: readonly PlacedField[]): EditorState {
  return { fields: [...fields], selection: [], past: [], future: [], gesture: null, rev: 0, lastUndo: null, lastRedo: null, guides: null };
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
    lastRedo: null,
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
      return { ...state, fields, selection: keepSelection(state.selection, fields), past: state.past.slice(0, -1), future: [...state.future, entry], rev: state.rev + 1, lastUndo: entry.label, lastRedo: null };
    }
    case 'redo': {
      const entry = state.future[state.future.length - 1];
      if (entry === undefined) return state;
      const fields = applyChanges(state.fields, entry.changes, 'after');
      return { ...state, fields, selection: keepSelection(state.selection, fields), past: [...state.past, entry], future: state.future.slice(0, -1), rev: state.rev + 1, lastUndo: null, lastRedo: entry.label };
    }
    case 'gesture-start':
      return { ...state, gesture: { before: state.fields } };
    case 'gesture-move': {
      const before = state.gesture?.before;
      const origin = before?.find((f) => f.id === action.id);
      if (before === undefined || origin === undefined || origin.locked === true) return state;
      const page = ctx.pageSize({ docId: origin.docId, page: origin.page });
      if (page === undefined) return state;
      const ids = new Set(action.ids ?? [action.id]);
      ids.add(action.id);
      const movers = before.flatMap((f) => {
        if (!ids.has(f.id) || f.locked === true || f.hidden === true) return [];
        const pg = ctx.pageSize({ docId: f.docId, page: f.page });
        return pg === undefined ? [] : [{ f, page: pg, tl: toTopLeft(boxOf(f), pg.height) }];
      });
      const others = before.filter((f) => !ids.has(f.id) && f.hidden !== true && f.docId === origin.docId && f.page === origin.page).map((f) => toTopLeft(boxOf(f), page.height));
      const tl = toTopLeft(boxOf(origin), page.height);
      const next = new Map<string, Box>();
      let guides: PageGuides | null = null;
      if (action.mode === 'move') {
        let d = clampGroupDelta(movers.map((m) => ({ box: m.tl, page: m.page })), action.dx, action.dy);
        if (action.snap) {
          const s = snapMove({ ...tl, x: tl.x + d.dx, y: tl.y + d.dy }, others, action.snap);
          const snapped = clampGroupDelta(movers.map((m) => ({ box: m.tl, page: m.page })), d.dx + s.dx, d.dy + s.dy);
          // Keep a guide only where the snap survived the page clamp.
          const xs = Math.abs(snapped.dx - (d.dx + s.dx)) < 0.001 ? s.xs : [];
          const ys = Math.abs(snapped.dy - (d.dy + s.dy)) < 0.001 ? s.ys : [];
          d = snapped;
          if (xs.length > 0 || ys.length > 0) guides = { docId: origin.docId, page: origin.page, xs, ys };
        }
        for (const m of movers) next.set(m.f.id, roundGestureBox(clampBox({ ...m.tl, x: m.tl.x + d.dx, y: m.tl.y + d.dy }, m.page), m.page, ctx.precision));
      } else {
        let dw = action.dx;
        let dh = action.dy;
        if (action.snap) {
          const s = snapResize({ ...tl, width: tl.width + dw, height: tl.height + dh }, others, action.snap);
          dw += s.dx;
          dh += s.dy;
          if (s.xs.length > 0 || s.ys.length > 0) guides = { docId: origin.docId, page: origin.page, xs: s.xs, ys: s.ys };
        }
        for (const m of movers) next.set(m.f.id, roundGestureBox(clampBox({ ...m.tl, width: m.tl.width + dw, height: m.tl.height + dh }, m.page), m.page, ctx.precision));
      }
      const fields = state.fields.map((f) => {
        const b = next.get(f.id);
        return b === undefined ? f : withBox(f, b);
      });
      const changed = fields.some((f, i) => f !== state.fields[i]);
      return { ...state, fields, guides, rev: changed ? state.rev + 1 : state.rev };
    }
    case 'gesture-end': {
      const g = state.gesture;
      if (g === null) return state;
      const done = { ...state, gesture: null, guides: null };
      const changes = diffFields(g.before, state.fields);
      if (changes.length === 0) return done;
      return { ...done, past: [...state.past, { label: action.label, changes }].slice(-HISTORY_LIMIT), future: [], lastUndo: null, lastRedo: null };
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

/**
 * Keyboard move by (dx, dy) points in the top-left frame (down = +dy), kept inside the page.
 * Several fields move together: at a page edge the whole selection stops, keeping its shape.
 */
export function nudgeFields(ids: readonly string[], dx: number, dy: number, label = 'Move field'): Command {
  const set = new Set(ids);
  return {
    label,
    run: (fields, ctx) => {
      const items = fields.flatMap((f) => {
        if (!set.has(f.id) || !editable(f)) return [];
        const page = ctx.pageSize({ docId: f.docId, page: f.page });
        return page === undefined ? [] : [{ id: f.id, box: toTopLeft(boxOf(f), page.height), page }];
      });
      const d = clampGroupDelta(items, dx, dy);
      const byId = new Map(items.map((i) => [i.id, i]));
      return fields.map((f) => {
        const i = byId.get(f.id);
        return i === undefined ? f : withBox(f, toPdf(clampBox({ ...i.box, x: i.box.x + d.dx, y: i.box.y + d.dy }, i.page), i.page.height));
      });
    },
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
  return assignFields([id], to, label);
}

/** P2-2 — reassign many fields at once (locked fields keep theirs). */
export function assignFields(ids: readonly string[], to: { readonly assignee: string | null; readonly binding: string | null }, label = 'Change who fills the fields'): Command {
  const set = new Set(ids);
  return {
    label,
    run: (fields) => fields.map((f) => (set.has(f.id) && editable(f) && (f.assignee !== to.assignee || f.binding !== to.binding) ? { ...f, assignee: to.assignee, binding: to.binding } : f)),
  };
}

/** P2-1 — add many fields (duplicate, paste, Repeat down): one command, so one undo step. */
export function placeFields(added: readonly PlacedField[], label = 'Add fields'): Command {
  return { label, run: (fields) => [...fields, ...added] };
}

/**
 * Rearrange the editable, visible fields among `ids`, page by page (fields on different pages
 * are arranged with the others on their own page), in the top-left frame; each result is
 * clamped to its page and rounded by the host's precision rule.
 */
function arrange(ids: readonly string[], label: string, step: (boxes: Box[], fields: PlacedField[]) => Box[]): Command {
  const set = new Set(ids);
  return {
    label,
    run: (fields, ctx) => {
      const groups = new Map<string, PlacedField[]>();
      for (const f of fields) {
        if (!set.has(f.id) || !editable(f) || f.hidden === true) continue;
        const k = `${f.docId}\u0000${f.page}`;
        groups.set(k, [...(groups.get(k) ?? []), f]);
      }
      const next = new Map<string, Box>();
      for (const group of groups.values()) {
        const first = group[0]!;
        const page = ctx.pageSize({ docId: first.docId, page: first.page });
        if (page === undefined) continue;
        // Order the group by the caller's id order (the first id is the anchor).
        const ordered = [...group].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        const input = ordered.map((f) => toTopLeft(boxOf(f), page.height));
        const out = step(input, ordered);
        ordered.forEach((f, i) => {
          const o = out[i]!;
          const x = input[i]!;
          // A field the step leaves where it is keeps its stored box exactly (no re-rounding).
          if (o.x === x.x && o.y === x.y && o.width === x.width && o.height === x.height) return;
          next.set(f.id, roundGestureBox(clampBox(o, page), page, ctx.precision));
        });
      }
      return fields.map((f) => {
        const b = next.get(f.id);
        return b === undefined ? f : withBox(f, b);
      });
    },
  };
}

const ALIGN_LABEL: Readonly<Record<AlignEdge, string>> = {
  left: 'Align left',
  hcenter: 'Align centre',
  right: 'Align right',
  top: 'Align top',
  vcenter: 'Align middle',
  bottom: 'Align bottom',
};

/** P2-2 — align to the selection's left / centre / right / top / middle / bottom (per page). */
export function alignFields(ids: readonly string[], edge: AlignEdge): Command {
  return arrange(ids, ALIGN_LABEL[edge], (boxes) => alignBoxes(boxes, edge));
}

/** P2-2 — equal gaps between 3 or more fields (per page); the outermost two stay. */
export function distributeFields(ids: readonly string[], axis: Axis): Command {
  return arrange(ids, axis === 'horizontal' ? 'Distribute horizontally' : 'Distribute vertically', (boxes) => distributeBoxes(boxes, axis));
}

/** P2-2 — give every field the anchor's (the first id's) width or height; top-left corners stay. */
export function sameSizeFields(ids: readonly string[], dim: Dimension): Command {
  const anchorId = ids[0];
  return {
    label: dim === 'width' ? 'Make same width' : 'Make same height',
    run: (fields, ctx) => {
      const anchor = fields.find((f) => f.id === anchorId);
      if (anchor === undefined) return [...fields];
      const page = ctx.pageSize({ docId: anchor.docId, page: anchor.page });
      if (page === undefined) return [...fields];
      const a = toTopLeft(boxOf(anchor), page.height);
      return arrange(ids, '', (boxes) => sameSizeBoxes(boxes, a, dim)).run(fields, ctx);
    },
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
