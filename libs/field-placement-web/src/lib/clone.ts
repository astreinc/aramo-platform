// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-1 —
// building the copies behind duplicate, paste and Repeat down. Pure: the editor calls these in
// its event handlers (never inside the reducer, so the host's newFieldId runs exactly once per
// copy) and adds the result with ONE placeFields command, so each action is one undo step.
//
// Rules:
// - A locked (engine-only) or hidden field is never copied (it can't be edited, so it can't be
//   duplicated either — the P1-5 rule).
// - A copy keeps type, size, assignee / binding, required and settings; it gets a new id from
//   the host's newFieldId (called with the fields so far, so the console's text_1, text_2 … run on).
// - Positions are clamped to the page and rounded by the host's precision rule.
// - Check-box groups: a duplicated or pasted box stays in its group. Repeat down copies a ROW, so
//   each new row gets its own copy of every group in the row: the group key gains a row suffix
//   (`<key>_2`, `<key>_3` …; the next free one, cut to the host's group-key limit), and the
//   group's rule, minimum and required setting come with it.

import { roundGestureBox, type DragPrecision } from './editor-state';
import { boundsOf } from './arrange';
import { clampBox, toTopLeft, type Box, type PdfPageInfo } from './geometry';
import { type PageRef, type PlacedField } from './model';

/** The step a duplicate (or a paste onto the same page) moves right and down, in points. */
export const DUPLICATE_OFFSET = 10;
/** The most rows one Repeat down may add. */
export const REPEAT_MAX = 50;
/** The gap Repeat down suggests between rows (points), added to the row's height. */
export const REPEAT_DEFAULT_GAP = 6;

export interface CloneContext {
  readonly pageSize: (ref: PageRef) => PdfPageInfo | undefined;
  readonly precision: DragPrecision;
  /** The host's id for a new field of `type`, given every field so far. */
  readonly newId: (type: string, fields: readonly PlacedField[]) => string;
}

/** Whether a field may be copied (and arranged): not locked, not hidden. */
export const copyable = (f: PlacedField): boolean => f.locked !== true && f.hidden !== true;

const tlOf = (f: PlacedField, page: PdfPageInfo): Box => toTopLeft({ x: f.x, y: f.y, width: f.width, height: f.height }, page.height);

/** Rebuild one field at a top-left box on a page (clamped, rounded by the host rule). */
function placeAt(f: PlacedField, tl: Box, ref: PageRef, page: PdfPageInfo, precision: DragPrecision, id: string): PlacedField {
  const b = roundGestureBox(clampBox(tl, page), page, precision);
  return { ...f, id, docId: ref.docId, page: ref.page, x: b.x, y: b.y, width: b.width, height: b.height };
}

/**
 * Copies of `sources` moved by (dx, dy) points in the top-left frame (down = +dy) and, when
 * `target` is given, onto that page at the same position. Locked / hidden sources are skipped.
 */
export function cloneFields(
  all: readonly PlacedField[],
  sources: readonly PlacedField[],
  opts: { readonly dx: number; readonly dy: number; readonly target?: PageRef },
  ctx: CloneContext,
): PlacedField[] {
  const out: PlacedField[] = [];
  for (const f of sources.filter(copyable)) {
    const ref = opts.target ?? { docId: f.docId, page: f.page };
    const from = ctx.pageSize({ docId: f.docId, page: f.page });
    const to = ctx.pageSize(ref);
    if (from === undefined || to === undefined) continue;
    const tl = tlOf(f, from);
    const id = ctx.newId(f.type, [...all, ...out]);
    out.push(placeAt(f, { ...tl, x: tl.x + opts.dx, y: tl.y + opts.dy }, ref, to, ctx.precision, id));
  }
  return out;
}

/** The row height and suggested distance between rows (top to top) for a selection on one page. */
export function repeatPitchOf(sources: readonly PlacedField[], pageSize: CloneContext['pageSize']): number | null {
  const rows = sources.filter(copyable);
  const first = rows[0];
  if (first === undefined || rows.some((f) => f.docId !== first.docId || f.page !== first.page)) return null;
  const page = pageSize({ docId: first.docId, page: first.page });
  if (page === undefined) return null;
  const b = boundsOf(rows.map((f) => tlOf(f, page)))!;
  return Math.ceil(b.height) + REPEAT_DEFAULT_GAP;
}

export type RepeatResult =
  | { readonly ok: true; readonly fields: PlacedField[]; readonly rows: number; readonly skipped: number }
  | { readonly ok: false; readonly reason: 'nothing' | 'pages' };

/**
 * Repeat down: `count` copies of the selected row, each `pitch` points (top to top) below the
 * one before. Rows that would run past the bottom of the page are not added (`skipped`). All
 * sources must be on one page.
 */
export function repeatDown(
  all: readonly PlacedField[],
  sources: readonly PlacedField[],
  opts: { readonly count: number; readonly pitch: number; readonly groupKeyMax?: number },
  ctx: CloneContext,
): RepeatResult {
  const row = sources.filter(copyable);
  const first = row[0];
  if (first === undefined) return { ok: false, reason: 'nothing' };
  if (row.some((f) => f.docId !== first.docId || f.page !== first.page)) return { ok: false, reason: 'pages' };
  const ref: PageRef = { docId: first.docId, page: first.page };
  const page = ctx.pageSize(ref);
  if (page === undefined) return { ok: false, reason: 'nothing' };
  const count = Math.max(0, Math.min(REPEAT_MAX, Math.floor(opts.count)));
  const pitch = Math.max(1, opts.pitch);
  const bounds = boundsOf(row.map((f) => tlOf(f, page)))!;
  const taken = new Set(all.filter((f) => f.type === 'CHECKBOX').map((f) => f.settings.groupKey.trim()).filter((k) => k.length > 0));
  const out: PlacedField[] = [];
  let rows = 0;
  for (let r = 1; r <= count; r += 1) {
    if (bounds.y + bounds.height + r * pitch > page.height + 0.001) break;
    rows += 1;
    const keys = new Map<string, string>();
    for (const f of row) {
      const g = f.type === 'CHECKBOX' ? f.settings.groupKey.trim() : '';
      let settings = f.settings;
      if (g.length > 0) {
        const groupId = `${f.assignee ?? ''}\u0000${g}`;
        let key = keys.get(groupId);
        if (key === undefined) {
          key = nextGroupKey(g, r + 1, taken, opts.groupKeyMax);
          taken.add(key);
          keys.set(groupId, key);
        }
        settings = { ...f.settings, groupKey: key };
      }
      const tl = tlOf(f, page);
      const id = ctx.newId(f.type, [...all, ...out]);
      out.push(placeAt({ ...f, settings }, { ...tl, y: tl.y + r * pitch }, ref, page, ctx.precision, id));
    }
  }
  return { ok: true, fields: out, rows, skipped: count - rows };
}

/** `<base>_<n>` (or the next free number), cut so it fits the host's group-key limit. */
export function nextGroupKey(base: string, n: number, taken: ReadonlySet<string>, max?: number): string {
  for (let i = n; ; i += 1) {
    const suffix = `_${i}`;
    const head = max !== undefined ? base.slice(0, Math.max(1, max - suffix.length)) : base;
    const key = `${head}${suffix}`;
    if (!taken.has(key)) return key;
  }
}
