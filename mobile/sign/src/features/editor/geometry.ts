// Field geometry — pure, renderer-free, and identical to the web editor
// (apps/sign-web/src/workspace/geometry.ts) and the server's validation
// (apps/sign-service/src/app/sender/sender-envelope.service.ts:38-43, replaceFields).
//
// Three frames:
//   WIRE    PDF-native. page_number 0-based, points, origin at the page's
//           BOTTOM-LEFT corner, (x, y) = the box's lower-left corner. What the
//           server stores, validates and stamps.
//   EDITOR  PDF points with a TOP-LEFT origin, (x, y) = the box's top-left corner.
//           What the editor state holds (the same frame the web editor uses).
//   SCREEN  device-independent pixels inside the rendered page view, top-left
//           origin. scale = rendered width / page width in points.

export interface PageSize {
  /** Points (pdf-lib page.getWidth(), the MediaBox width). */
  readonly width: number;
  readonly height: number;
}

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** Smallest box the resize handle allows (handoff §4.6). */
export const MIN_FIELD_WIDTH = 14;
export const MIN_FIELD_HEIGHT = 12;
/** A drag starts after this much movement, in screen pixels (handoff §4.6). */
export const DRAG_THRESHOLD_PX = 4;
/** The server accepts a box up to half a point past the page edge (rounding slack). */
export const SERVER_EDGE_TOLERANCE = 0.5;

/** Two-decimal rounding, the precision the server stores (Math.round(v * 100) / 100). */
export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** WIRE (bottom-left) -> EDITOR (top-left). */
export function wireToEditor(b: Box, page: PageSize): Box {
  return { x: b.x, y: page.height - b.y - b.height, width: b.width, height: b.height };
}

/** EDITOR (top-left) -> WIRE (bottom-left), rounded to the server's precision. */
export function editorToWire(b: Box, page: PageSize): Box {
  return {
    x: round2(b.x),
    y: round2(page.height - b.y - b.height),
    width: round2(b.width),
    height: round2(b.height),
  };
}

/** Rendered pixels per PDF point for a page drawn `renderedWidth` pixels wide. */
export function scaleFor(page: PageSize, renderedWidth: number): number {
  if (!(page.width > 0) || !(renderedWidth > 0)) throw new Error('invalid page or view width');
  return renderedWidth / page.width;
}

/** SCREEN point (inside the page view) -> EDITOR point in PDF points. */
export function screenToEditorPoint(p: Point, scale: number): Point {
  return { x: p.x / scale, y: p.y / scale };
}

/** EDITOR box -> SCREEN box (for drawing the overlay). */
export function editorToScreenBox(b: Box, scale: number): Box {
  return { x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale };
}

/** SCREEN box -> EDITOR box. */
export function screenToEditorBox(b: Box, scale: number): Box {
  return { x: b.x / scale, y: b.y / scale, width: b.width / scale, height: b.height / scale };
}

/** One step: a tap on the rendered page -> the WIRE point the server would see. */
export function screenToWirePoint(p: Point, page: PageSize, renderedWidth: number): Point {
  const e = screenToEditorPoint(p, scaleFor(page, renderedWidth));
  return { x: round2(e.x), y: round2(page.height - e.y) };
}

/** Keep a box inside its page, no smaller than the minimum, no larger than the page. */
export function clampBox(b: Box, page: PageSize): Box {
  const width = Math.max(MIN_FIELD_WIDTH, Math.min(b.width, page.width));
  const height = Math.max(MIN_FIELD_HEIGHT, Math.min(b.height, page.height));
  return {
    width,
    height,
    x: Math.max(0, Math.min(page.width - width, b.x)),
    y: Math.max(0, Math.min(page.height - height, b.y)),
  };
}

/** A box of `size` centred on `center` (EDITOR frame), kept inside the page. */
export function centeredBox(
  center: Point,
  size: { readonly width: number; readonly height: number },
  page: PageSize,
): Box {
  return clampBox(
    {
      x: center.x - size.width / 2,
      y: center.y - size.height / 2,
      width: size.width,
      height: size.height,
    },
    page,
  );
}

/** Move a box's top-left corner to (x, y), staying inside the page. */
export function moveBoxTo(b: Box, to: Point, page: PageSize): Box {
  return clampBox({ ...b, x: to.x, y: to.y }, page);
}

/**
 * Resize from the bottom-right handle: the top-left corner stays put, the size is at
 * least the minimum and the box never crosses the page's right or bottom edge.
 */
export function resizeBoxTo(
  b: Box,
  size: { readonly width: number; readonly height: number },
  page: PageSize,
): Box {
  const width = Math.max(MIN_FIELD_WIDTH, Math.min(size.width, page.width - b.x));
  const height = Math.max(MIN_FIELD_HEIGHT, Math.min(size.height, page.height - b.y));
  return clampBox({ x: b.x, y: b.y, width, height }, page);
}

/** True once a press has moved far enough to be a drag rather than a tap. */
export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX;
}

/** The server's acceptance rule for one WIRE box on its page (replaceFields). */
export function wireBoxAccepted(b: Box, page: PageSize): boolean {
  return (
    Number.isFinite(b.x) &&
    Number.isFinite(b.y) &&
    b.x >= 0 &&
    b.y >= 0 &&
    b.width > 0 &&
    b.height > 0 &&
    b.x + b.width <= page.width + SERVER_EDGE_TOLERANCE &&
    b.y + b.height <= page.height + SERVER_EDGE_TOLERANCE
  );
}
