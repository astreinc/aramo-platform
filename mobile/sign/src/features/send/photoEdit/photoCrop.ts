// M-A13 #9 — geometry for the per-photo crop / straighten / rotate step.
//
// The photo is turned clockwise by `quarter` (0/90/180/270) plus a small straighten
// angle (−45…45°). Turning a picture by a non-right angle grows its bounding box and
// leaves empty corners, so the crop is kept inside the largest same-shape rectangle that
// fits in the turned picture ("bounds"). Crops are fractions (0…1) of the turned
// picture's bounding box, so they do not depend on the pixel size the native rotate
// rounds to.

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** A rectangle as fractions (0…1) of the turned picture's bounding box. */
export interface FracRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface PhotoEdit {
  /** Clockwise quarter turns, in degrees: 0, 90, 180 or 270. */
  readonly quarter: number;
  /** Straighten, in degrees, −45…45 (clockwise positive). */
  readonly straighten: number;
  readonly crop: FracRect;
}

export const STRAIGHTEN_LIMIT = 45;
const EPS = 1e-6;

export function normalizeQuarter(deg: number): number {
  return (((Math.round(deg / 90) * 90) % 360) + 360) % 360;
}

export function clampStraighten(deg: number): number {
  return Math.max(-STRAIGHTEN_LIMIT, Math.min(STRAIGHTEN_LIMIT, Math.round(deg)));
}

/** Total clockwise rotation handed to the image manipulator. */
export function totalRotation(e: Pick<PhotoEdit, 'quarter' | 'straighten'>): number {
  return normalizeQuarter(e.quarter) + clampStraighten(e.straighten);
}

/** The picture's size after the quarter turns (before straightening). */
export function quarterSize(src: Size, quarter: number): Size {
  return normalizeQuarter(quarter) % 180 === 0
    ? src
    : { width: src.height, height: src.width };
}

/** Bounding box of the picture turned by quarter + straighten. */
export function turnedBox(src: Size, quarter: number, straighten: number): Size {
  const q = quarterSize(src, quarter);
  const a = (Math.abs(clampStraighten(straighten)) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { width: q.width * c + q.height * s, height: q.width * s + q.height * c };
}

/** The largest same-shape rectangle inside the turned picture, as fractions of its box. */
export function cropBounds(src: Size, quarter: number, straighten: number): FracRect {
  const q = quarterSize(src, quarter);
  const box = turnedBox(src, quarter, straighten);
  const a = (Math.abs(clampStraighten(straighten)) * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const k = Math.min(q.width / (q.width * c + q.height * s), q.height / (q.width * s + q.height * c));
  const w = (k * q.width) / box.width;
  const h = (k * q.height) / box.height;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

export function initialEdit(): PhotoEdit {
  return { quarter: 0, straighten: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };
}

/** An edit that changes nothing (no turn, crop = the whole picture). */
export function isIdentity(e: PhotoEdit): boolean {
  return (
    totalRotation(e) % 360 === 0 &&
    e.crop.x <= EPS &&
    e.crop.y <= EPS &&
    e.crop.w >= 1 - EPS &&
    e.crop.h >= 1 - EPS
  );
}

export type Corner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * Move one corner of the crop by (dx, dy) fractions, keeping it inside `bounds` and at
 * least `min` (fractions per axis) in size.
 */
export function moveCorner(
  crop: FracRect,
  corner: Corner,
  dx: number,
  dy: number,
  bounds: FracRect,
  min: { readonly w: number; readonly h: number },
): FracRect {
  let left = crop.x;
  let top = crop.y;
  let right = crop.x + crop.w;
  let bottom = crop.y + crop.h;
  const bRight = bounds.x + bounds.w;
  const bBottom = bounds.y + bounds.h;
  if (corner === 'tl' || corner === 'bl') left = clamp(left + dx, bounds.x, right - min.w);
  else right = clamp(right + dx, left + min.w, bRight);
  if (corner === 'tl' || corner === 'tr') top = clamp(top + dy, bounds.y, bottom - min.h);
  else bottom = clamp(bottom + dy, top + min.h, bBottom);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Crop fractions to whole pixels of an image of `size`, never outside it. */
export function cropPixels(
  crop: FracRect,
  size: Size,
): { originX: number; originY: number; width: number; height: number } {
  const x = clamp(Math.round(crop.x * size.width), 0, size.width - 1);
  const y = clamp(Math.round(crop.y * size.height), 0, size.height - 1);
  const w = clamp(Math.round(crop.w * size.width), 1, size.width - x);
  const h = clamp(Math.round(crop.h * size.height), 1, size.height - y);
  return { originX: x, originY: y, width: w, height: h };
}

/** Where the turned picture sits on a stage of `area`: its scale and box offset. */
export function stageLayout(
  src: Size,
  quarter: number,
  straighten: number,
  area: Size,
): { readonly scale: number; readonly box: Size; readonly left: number; readonly top: number } {
  const turned = turnedBox(src, quarter, straighten);
  const scale = Math.min(area.width / turned.width, area.height / turned.height);
  const box = { width: turned.width * scale, height: turned.height * scale };
  return { scale, box, left: (area.width - box.width) / 2, top: (area.height - box.height) / 2 };
}
