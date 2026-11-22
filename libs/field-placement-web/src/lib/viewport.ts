// FIELD-PARITY-1 P0-1 (Sign Field Placement Enterprise Parity Directive v1.0 LOCKED §3.1) —
// pure helpers behind the placement editor's scrolling page column (FIELD-PARITY-1 P1-5: moved
// from libs/document-templates-web fixed-form-viewport.ts, unchanged, so sign-web Prepare and the
// console form Studio share them):
//   R-2  the target page follows the view: the page with the largest visible area;
//   R-3  a new field lands inside the visible part of the target page.
// No DOM here: the Studio measures rects and passes plain numbers, so these are unit-tested.
// Field coordinates stay PDF-native (points, bottom-left origin) — nothing here changes what a
// saved x/y means; it only chooses where a NEW field starts.

/** A screen rectangle (CSS px), e.g. from getBoundingClientRect(). */
export interface ScreenRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The visible part of one page, in PDF points in the editor's TOP-LEFT frame. */
export interface PageRegion {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface PageSize {
  readonly width: number;
  readonly height: number;
}

/** The intersection of two screen rects, or null when they do not overlap. */
export function intersectRects(a: ScreenRect, b: ScreenRect): ScreenRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/** Visible area (px²) of a page rect inside the view rect. */
export function visibleArea(page: ScreenRect, view: ScreenRect): number {
  const i = intersectRects(page, view);
  return i === null ? 0 : (i.right - i.left) * (i.bottom - i.top);
}

/**
 * R-2 — the target page for the current view: the page with the largest visible area. Ties keep
 * `current` when it is among the largest (no flicker between two equally visible pages), else the
 * first. Nothing visible (or no pages) keeps `current`.
 */
export function pickTargetPage(areas: readonly number[], current: number): number {
  let best = -1;
  let bestArea = 0;
  areas.forEach((a, i) => {
    if (a > bestArea) {
      best = i;
      bestArea = a;
    }
  });
  if (best < 0) return current;
  if (current >= 0 && current < areas.length && areas[current] === bestArea) return current;
  return best;
}

/**
 * The visible part of a page in PDF points (top-left frame), from its screen rect, the view rect
 * and the page size in points. Null when the page is not in view.
 */
export function visibleRegionInPage(page: ScreenRect, view: ScreenRect, size: PageSize): PageRegion | null {
  const i = intersectRects(page, view);
  const widthPx = page.right - page.left;
  if (i === null || widthPx <= 0 || size.width <= 0) return null;
  const s = widthPx / size.width;
  return {
    left: (i.left - page.left) / s,
    top: (i.top - page.top) / s,
    right: (i.right - page.left) / s,
    bottom: (i.bottom - page.top) / s,
  };
}

/** Inset of a new field from the top-left of the visible region (points). */
export const NEW_FIELD_INSET = 72;
/** Cascade step per field already on the page (points), cycling every NEW_FIELD_CASCADE_CYCLE. */
export const NEW_FIELD_CASCADE_STEP = 12;
export const NEW_FIELD_CASCADE_CYCLE = 10;
/** Where a new field's top sits when the visible region is unknown (the pre-P0-1 placement). */
export const NEW_FIELD_FALLBACK_TOP = 144;

const round2 = (n: number): number => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/**
 * R-3 — the PDF-native (bottom-left origin, points) x/y of a new field on `page`: at the top-left
 * of the visible region plus an inset, cascading by `cascade` (the count of fields already on that
 * page), kept inside the visible region when it fits and always inside the page bounds. With no
 * visible region (unknown / not in view) the field takes the original fixed spot near the top.
 */
export function placeNewField(args: {
  readonly page: PageSize;
  readonly visible: PageRegion | null;
  readonly size: PageSize;
  readonly cascade: number;
}): { x: number; y: number } {
  const { page, visible, size } = args;
  const offset = (Math.max(0, Math.floor(args.cascade)) % NEW_FIELD_CASCADE_CYCLE) * NEW_FIELD_CASCADE_STEP;
  const maxLeft = Math.max(0, page.width - size.width);
  const maxTop = Math.max(0, page.height - size.height);
  let left: number;
  let top: number;
  if (visible === null) {
    left = NEW_FIELD_INSET + offset;
    top = NEW_FIELD_FALLBACK_TOP + offset;
  } else {
    // Insets shrink on a small visible region so the box still starts inside it.
    const w = visible.right - visible.left;
    const h = visible.bottom - visible.top;
    const insetX = Math.min(NEW_FIELD_INSET, Math.max(0, (w - size.width) / 2));
    const insetY = Math.min(NEW_FIELD_INSET, Math.max(0, (h - size.height) / 2));
    left = visible.left + insetX + offset;
    top = visible.top + insetY + offset;
    // Inside the visible region when the box fits in it.
    if (size.width <= w) left = clamp(left, visible.left, visible.right - size.width);
    if (size.height <= h) top = clamp(top, visible.top, visible.bottom - size.height);
  }
  left = clamp(left, 0, maxLeft);
  top = clamp(top, 0, maxTop);
  return { x: round2(left), y: round2(Math.max(0, page.height - top - size.height)) };
}
