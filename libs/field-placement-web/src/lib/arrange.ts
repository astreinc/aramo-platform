// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5
// P2-2 / P2-3 — the pure geometry behind multi-select and arrange: drag-a-box selection, align,
// distribute, same size, and snapping to other fields' edges (and an optional grid) with the
// alignment guides to draw. Every helper works in the editor's TOP-LEFT frame, in PDF points;
// the commands in editor-state.ts convert to and from the stored PDF-native frame.

import { type Box, type PdfPageInfo } from './geometry';

/** The smallest box holding every box (null for none). */
export function boundsOf(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b.x));
  const top = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A box between two pointer points (any drag direction). */
export function rectFromPoints(a: { readonly x: number; readonly y: number }, b: { readonly x: number; readonly y: number }): Box {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

/** Drag-a-box selection: whether a field's box touches the drawn box (touching selects, as in most design tools). */
export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// ---- Align / distribute / same size ---------------------------------------------------------

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type Axis = 'horizontal' | 'vertical';
export type Dimension = 'width' | 'height';

/** Align boxes to the edge (or centre) of their common bounds. Order is kept. */
export function alignBoxes(boxes: readonly Box[], edge: AlignEdge): Box[] {
  const b = boundsOf(boxes);
  if (b === null || boxes.length < 2) return [...boxes];
  return boxes.map((x) => {
    switch (edge) {
      case 'left':
        return { ...x, x: b.x };
      case 'right':
        return { ...x, x: b.x + b.width - x.width };
      case 'hcenter':
        return { ...x, x: b.x + (b.width - x.width) / 2 };
      case 'top':
        return { ...x, y: b.y };
      case 'bottom':
        return { ...x, y: b.y + b.height - x.height };
      case 'vcenter':
        return { ...x, y: b.y + (b.height - x.height) / 2 };
    }
  });
}

/**
 * Distribute boxes evenly: the first and last (by position along the axis) stay; the others are
 * spaced so every gap between neighbours is equal. Needs 3 or more boxes. Order is kept.
 */
export function distributeBoxes(boxes: readonly Box[], axis: Axis): Box[] {
  if (boxes.length < 3) return [...boxes];
  const pos = (b: Box) => (axis === 'horizontal' ? b.x : b.y);
  const len = (b: Box) => (axis === 'horizontal' ? b.width : b.height);
  const order = boxes.map((b, i) => i).sort((i, j) => pos(boxes[i]!) - pos(boxes[j]!) || i - j);
  const first = boxes[order[0]!]!;
  const last = boxes[order[order.length - 1]!]!;
  const span = pos(last) + len(last) - pos(first);
  const total = boxes.reduce((s, b) => s + len(b), 0);
  const gap = (span - total) / (boxes.length - 1);
  const out = [...boxes];
  let at = pos(first);
  for (const i of order) {
    const b = boxes[i]!;
    out[i] = axis === 'horizontal' ? { ...b, x: at } : { ...b, y: at };
    at += len(b) + gap;
  }
  return out;
}

/** Give every box the anchor's width or height (each box keeps its top-left corner). */
export function sameSizeBoxes(boxes: readonly Box[], anchor: Box, dim: Dimension): Box[] {
  return boxes.map((b) => (dim === 'width' ? { ...b, width: anchor.width } : { ...b, height: anchor.height }));
}

// ---- Snap and guides ------------------------------------------------------------------------

/** Default grid step (points) when the optional grid is on. */
export const GRID_STEP = 10;
/** How close (screen pixels) an edge must come to snap; the editor converts it to points. */
export const SNAP_DISTANCE_PX = 6;

export interface SnapOptions {
  /** Snap to the other fields' edges and centres. */
  readonly edges: boolean;
  /** Snap to a grid of this step (points), or null for no grid. */
  readonly grid: number | null;
  /** Points: an edge within this distance of a target snaps to it. */
  readonly threshold: number;
}

/** Guide lines to draw (top-left frame, points): vertical lines at `xs`, horizontal at `ys`. */
export interface GuideLines {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
}

export interface SnapResult extends GuideLines {
  /** The correction to add to the box position (move) or size (resize). */
  readonly dx: number;
  readonly dy: number;
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, xs: [], ys: [] };

/** The nearest target to any of `lines` within `threshold`: the correction and the target line. */
function nearest(lines: readonly number[], targets: readonly number[], threshold: number): { d: number; at: number } | null {
  let best: { d: number; at: number } | null = null;
  for (const l of lines) {
    for (const t of targets) {
      const d = t - l;
      if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
    }
  }
  return best;
}

const gridSnap = (v: number, step: number): number => Math.round(v / step) * step - v;

/**
 * Snap a moving box. Its left, centre and right lines snap to the other boxes' left, centre and
 * right lines (likewise top, middle, bottom); with no edge in reach, the top-left corner snaps
 * to the grid when the grid is on. Returns the correction and the guide lines to draw.
 */
export function snapMove(box: Box, others: readonly Box[], opts: SnapOptions): SnapResult {
  if (!opts.edges && opts.grid === null) return NO_SNAP;
  const xsOf = (b: Box) => [b.x, b.x + b.width / 2, b.x + b.width];
  const ysOf = (b: Box) => [b.y, b.y + b.height / 2, b.y + b.height];
  const ex = opts.edges ? nearest(xsOf(box), others.flatMap(xsOf), opts.threshold) : null;
  const ey = opts.edges ? nearest(ysOf(box), others.flatMap(ysOf), opts.threshold) : null;
  const dx = ex !== null ? ex.d : opts.grid !== null ? gridSnap(box.x, opts.grid) : 0;
  const dy = ey !== null ? ey.d : opts.grid !== null ? gridSnap(box.y, opts.grid) : 0;
  return { dx, dy, ...guidesFor({ ...box, x: box.x + dx, y: box.y + dy }, others, 'move', ex !== null, ey !== null) };
}

/** Snap a resizing box (top-left fixed): its right and bottom edges snap like snapMove's lines. */
export function snapResize(box: Box, others: readonly Box[], opts: SnapOptions): SnapResult {
  if (!opts.edges && opts.grid === null) return NO_SNAP;
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const ex = opts.edges ? nearest([right], others.flatMap((b) => [b.x, b.x + b.width / 2, b.x + b.width]), opts.threshold) : null;
  const ey = opts.edges ? nearest([bottom], others.flatMap((b) => [b.y, b.y + b.height / 2, b.y + b.height]), opts.threshold) : null;
  const dx = ex !== null ? ex.d : opts.grid !== null ? gridSnap(right, opts.grid) : 0;
  const dy = ey !== null ? ey.d : opts.grid !== null ? gridSnap(bottom, opts.grid) : 0;
  return { dx, dy, ...guidesFor({ ...box, width: box.width + dx, height: box.height + dy }, others, 'resize', ex !== null, ey !== null) };
}

const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

/** Every line of the (snapped) box that lines up with another box's line, per axis that snapped. */
function guidesFor(box: Box, others: readonly Box[], mode: 'move' | 'resize', gx: boolean, gy: boolean): GuideLines {
  const mine = (b: Box, axis: 'x' | 'y'): number[] =>
    axis === 'x'
      ? mode === 'move'
        ? [b.x, b.x + b.width / 2, b.x + b.width]
        : [b.x + b.width]
      : mode === 'move'
        ? [b.y, b.y + b.height / 2, b.y + b.height]
        : [b.y + b.height];
  const theirs = (axis: 'x' | 'y') => others.flatMap((b) => (axis === 'x' ? [b.x, b.x + b.width / 2, b.x + b.width] : [b.y, b.y + b.height / 2, b.y + b.height]));
  const hits = (axis: 'x' | 'y') => {
    const t = theirs(axis);
    const out: number[] = [];
    for (const l of mine(box, axis)) if (t.some((v) => same(v, l)) && !out.some((v) => same(v, l))) out.push(l);
    return out;
  };
  return { xs: gx ? hits('x') : [], ys: gy ? hits('y') : [] };
}

/** Clamp a shared move (dx, dy) so every box stays inside its page (a group keeps its shape at the edge). */
export function clampGroupDelta(items: readonly { readonly box: Box; readonly page: PdfPageInfo }[], dx: number, dy: number): { dx: number; dy: number } {
  let lo = { x: -Infinity, y: -Infinity };
  let hi = { x: Infinity, y: Infinity };
  for (const { box, page } of items) {
    lo = { x: Math.max(lo.x, -box.x), y: Math.max(lo.y, -box.y) };
    hi = { x: Math.min(hi.x, page.width - box.x - box.width), y: Math.min(hi.y, page.height - box.y - box.height) };
  }
  const c = (v: number, a: number, b: number) => (a > b ? 0 : Math.max(a, Math.min(b, v)));
  return { dx: c(dx, lo.x, hi.x), dy: c(dy, lo.y, hi.y) };
}
