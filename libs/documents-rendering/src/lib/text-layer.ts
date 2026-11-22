import { PDFDocument } from 'pdf-lib';

// FIELD-PARITY-1 P2-6 — the PDF text layer and page geometry, moved here from
// apps/sign-service/src/app/text-layer (Aramo Sign Mobile M-A12 §2 W1-C.2 "Find in document";
// M-A14 field suggestions) so the console fixed-form upload (apps/api) reads text tags with
// the SAME extractor Sign uses. One copy: sign-service re-exports these unchanged.
//
//   Library   pdfjs-dist (a production dependency of the workspace) through its Node
//             "legacy" build. No new dependency. pdf-lib has no text extraction. pdfjs is
//             confined to this file (as pdf-lib is to the adapter, the safe-upload pipeline
//             and pdf-form-import.ts).
//   Output    each page's words, with boxes normalised to 0..1 of the page view (the crop
//             box), origin top-left. Image-only page: `words: []`.
//   Privacy   nothing here logs text.

export interface TextLayerWord {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TextLayerPage {
  page: number;
  words: TextLayerWord[];
}

// Bounds: a pathological PDF never pins the process or the cache.
export const TEXT_LAYER_MAX_PAGES = 2000;
export const TEXT_LAYER_MAX_WORDS = 250_000;

interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
}

interface PdfjsLike {
  getDocument(src: Record<string, unknown>): { promise: Promise<PdfDocLike> };
  Util: { transform(a: number[], b: number[]): number[] };
  OPS: Record<string, number>;
}

interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number; transform: number[] };
    getTextContent(): Promise<{ items: unknown[] }>;
    getOperatorList?(o?: { intent?: string }): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
    cleanup?: () => void;
  }>;
  destroy(): Promise<void>;
}

let pdfjsModule: Promise<PdfjsLike> | null = null;

function loadPdfjs(): Promise<PdfjsLike> {
  // The Node build of pdfjs-dist is ESM-only: a dynamic import (kept as import() by the
  // nodenext compiler) loads it on first use.
  pdfjsModule ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsLike>;
  return pdfjsModule;
}

const round = (n: number): number => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;

/** Splits one text run into words with boxes, apportioning the run by character position. */
export function wordsOfRun(str: string, tx: readonly number[], runWidth: number, pageWidth: number, pageHeight: number): TextLayerWord[] {
  const len = str.length;
  if (len === 0 || pageWidth <= 0 || pageHeight <= 0) return [];
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = tx;
  // Direction of the text baseline in viewport space, and the "up" vector (font height).
  const scale = Math.hypot(a, b);
  const dir = scale > 0 ? [a / scale, b / scale] : [1, 0];
  const up = [c, d];
  const out: TextLayerWord[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    const start = (m.index / len) * runWidth;
    const end = ((m.index + m[0].length) / len) * runWidth;
    const p0 = [e + (dir[0] ?? 0) * start, f + (dir[1] ?? 0) * start];
    const p1 = [e + (dir[0] ?? 0) * end, f + (dir[1] ?? 0) * end];
    const corners = [p0, p1, [(p0[0] ?? 0) + (up[0] ?? 0), (p0[1] ?? 0) + (up[1] ?? 0)], [(p1[0] ?? 0) + (up[0] ?? 0), (p1[1] ?? 0) + (up[1] ?? 0)]];
    const xs = corners.map((p) => p[0] ?? 0);
    const ys = corners.map((p) => p[1] ?? 0);
    const x0 = Math.min(...xs) / pageWidth;
    const x1 = Math.max(...xs) / pageWidth;
    const y0 = Math.min(...ys) / pageHeight;
    const y1 = Math.max(...ys) / pageHeight;
    const x = round(x0);
    const y = round(y0);
    out.push({ t: m[0], x, y, w: round(round(x1) - x), h: round(round(y1) - y) });
  }
  return out;
}

/** Extracts every page's words. Throws when the bytes are not a readable PDF. */
export async function extractTextLayer(bytes: Uint8Array): Promise<TextLayerPage[]> {
  const pdfjs = await loadPdfjs();
  // pdfjs takes ownership of (and may detach) the buffer it is given: pass a copy.
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const doc = await task.promise;
  try {
    const pages: TextLayerPage[] = [];
    let total = 0;
    const count = Math.min(doc.numPages, TEXT_LAYER_MAX_PAGES);
    for (let n = 1; n <= count; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const words: TextLayerWord[] = [];
      if (total < TEXT_LAYER_MAX_WORDS) {
        const content = await page.getTextContent();
        for (const raw of content.items) {
          const item = raw as PdfTextItem;
          if (typeof item.str !== 'string' || item.str.trim().length === 0 || !Array.isArray(item.transform)) continue;
          const tx = pdfjs.Util.transform(viewport.transform, item.transform);
          const runWidth = (item.width ?? 0) * Math.hypot(viewport.transform[0] ?? 1, viewport.transform[1] ?? 0);
          for (const w of wordsOfRun(item.str, tx, runWidth, viewport.width, viewport.height)) {
            if (total >= TEXT_LAYER_MAX_WORDS) break;
            words.push(w);
            total += 1;
          }
        }
      }
      page.cleanup?.();
      pages.push({ page: n, words });
    }
    return pages;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}

/** One page's geometry in PDF user space (points). */
export interface PdfPageFrame {
  /** The media box size (the field frame field boxes are validated against). */
  width: number;
  height: number;
  /** The crop box: the view the text layer's 0..1 boxes are relative to. */
  view: { x: number; y: number; width: number; height: number };
  /** Page rotation in degrees. */
  rotation: number;
}

/** Every page's frame (media box size, crop box, rotation), read with pdf-lib. */
export async function readPageFrames(bytes: Uint8Array): Promise<PdfPageFrame[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPages().map((p) => {
    const crop = p.getCropBox();
    return { width: p.getWidth(), height: p.getHeight(), view: { x: crop.x, y: crop.y, width: crop.width, height: crop.height }, rotation: p.getRotation().angle };
  });
}

// ── FIELD-PARITY-1 P2-4 — the drawn rectangles and straight lines of each page ─────────────────
// The field detector (@aramo/sign-fields detectFields) reads empty boxes and ruled table cells
// from these. Read from pdfjs's operator list (the same pdfjs-dist build as the text layer: no new
// dependency): every painted path made only of axis-aligned rectangles or straight horizontal /
// vertical segments, after the current transform, in the same frame as the text layer (0..1 of
// the page view, origin top-left). A clipping path (painted with endPath) and any curve are not
// shapes. Nothing is rendered; no text is read here.

/** A drawn rectangle or straight line (w or h 0 for a line): 0..1 of the page view, origin top-left. */
export interface PageGraphicRect {
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: boolean;
  fill: boolean;
}

export interface PageGraphics {
  page: number;
  rects: PageGraphicRect[];
}

/** Bounds: a pathological PDF never pins the process. */
export const PAGE_GRAPHICS_MAX_RECTS = 4000;
export const PAGE_GRAPHICS_MAX_OPS = 200_000;

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, n: readonly number[]): Matrix {
  // pdfjs Util.transform(m, n): apply n, then m (n is the inner transform).
  const [a, b, c, d, e, f] = m;
  const [na = 1, nb = 0, nc = 0, nd = 1, ne = 0, nf = 0] = n;
  return [a * na + c * nb, b * na + d * nb, a * nc + c * nd, b * nc + d * nd, a * ne + c * nf + e, b * ne + d * nf + f];
}

const apply = (m: Matrix, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Whether the matrix keeps axis-aligned boxes axis-aligned (scale / flip / quarter turns only). */
const axisAligned = (m: Matrix): boolean => (Math.abs(m[1]) < 1e-6 && Math.abs(m[2]) < 1e-6) || (Math.abs(m[0]) < 1e-6 && Math.abs(m[3]) < 1e-6);

interface PathShape {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The shapes of one constructPath call (pdfjs 4: args [ops, coords, minMax]), in viewport pixels
 * (scale 1). Null when the path holds a curve or a non-axis-aligned segment (not a shape).
 */
function shapesOfPath(OPS: Record<string, number>, ops: readonly number[], coords: readonly number[], m: Matrix): PathShape[] | null {
  if (!axisAligned(m)) return null;
  const out: PathShape[] = [];
  let j = 0;
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  // An open polyline of axis-aligned segments: each segment is its own line.
  const segment = (p: [number, number], q: [number, number]): boolean => {
    if (Math.abs(p[0] - q[0]) > 0.01 && Math.abs(p[1] - q[1]) > 0.01) return false;
    out.push({ x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) });
    return true;
  };
  for (const op of ops) {
    if (op === OPS['rectangle']) {
      const [x = 0, y = 0, w = 0, h = 0] = coords.slice(j, j + 4);
      j += 4;
      const p = apply(m, x, y);
      const q = apply(m, x + w, y + h);
      out.push({ x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) });
      cur = null;
      start = null;
    } else if (op === OPS['moveTo']) {
      cur = apply(m, coords[j] ?? 0, coords[j + 1] ?? 0);
      start = cur;
      j += 2;
    } else if (op === OPS['lineTo']) {
      const q = apply(m, coords[j] ?? 0, coords[j + 1] ?? 0);
      j += 2;
      if (cur === null || !segment(cur, q)) return null;
      cur = q;
    } else if (op === OPS['closePath']) {
      if (cur !== null && start !== null && (cur[0] !== start[0] || cur[1] !== start[1]) && !segment(cur, start)) return null;
      cur = start;
    } else {
      // curveTo / curveTo2 / curveTo3 (or anything unknown): not a shape.
      return null;
    }
  }
  return out;
}

/** A closed 4-segment outline (a rectangle drawn with moveTo / lineTo) reads as one rectangle. */
function mergeOutline(shapes: PathShape[]): PathShape[] {
  if (shapes.length !== 4) return shapes;
  const xs = shapes.flatMap((s) => [s.x0, s.x1]);
  const ys = shapes.flatMap((s) => [s.y0, s.y1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const h = shapes.filter((s) => Math.abs(s.y0 - s.y1) < 0.01 && Math.abs(s.x0 - x0) < 0.5 && Math.abs(s.x1 - x1) < 0.5).length;
  const v = shapes.filter((s) => Math.abs(s.x0 - s.x1) < 0.01 && Math.abs(s.y0 - y0) < 0.5 && Math.abs(s.y1 - y1) < 0.5).length;
  return h === 2 && v === 2 ? [{ x0, y0, x1, y1 }] : shapes;
}

/** Every page's drawn rectangles and straight lines. Throws when the bytes are not a readable PDF. */
export async function extractPageGraphics(bytes: Uint8Array): Promise<PageGraphics[]> {
  const pdfjs = await loadPdfjs();
  const OPS = pdfjs.OPS;
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0, stopAtErrors: false });
  const doc = await task.promise;
  const paint = new Map<number, { stroke: boolean; fill: boolean }>([
    [OPS['stroke'] ?? -1, { stroke: true, fill: false }],
    [OPS['closeStroke'] ?? -1, { stroke: true, fill: false }],
    [OPS['fill'] ?? -1, { stroke: false, fill: true }],
    [OPS['eoFill'] ?? -1, { stroke: false, fill: true }],
    [OPS['fillStroke'] ?? -1, { stroke: true, fill: true }],
    [OPS['eoFillStroke'] ?? -1, { stroke: true, fill: true }],
    [OPS['closeFillStroke'] ?? -1, { stroke: true, fill: true }],
    [OPS['closeEOFillStroke'] ?? -1, { stroke: true, fill: true }],
  ]);
  try {
    const pages: PageGraphics[] = [];
    const count = Math.min(doc.numPages, TEXT_LAYER_MAX_PAGES);
    for (let n = 1; n <= count; n += 1) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const rects: PageGraphicRect[] = [];
      const list = page.getOperatorList === undefined ? { fnArray: [], argsArray: [] } : await page.getOperatorList({ intent: 'display' });
      let ctm: Matrix = [...(viewport.transform as Matrix)];
      const stack: Matrix[] = [];
      let pending: PathShape[] | null = null;
      const total = Math.min(list.fnArray.length, PAGE_GRAPHICS_MAX_OPS);
      for (let i = 0; i < total && rects.length < PAGE_GRAPHICS_MAX_RECTS; i += 1) {
        const fn = list.fnArray[i];
        const args = list.argsArray[i] as unknown[] | null | undefined;
        if (fn === OPS['save']) stack.push(ctm);
        else if (fn === OPS['restore']) ctm = stack.pop() ?? ctm;
        else if (fn === OPS['transform'] && Array.isArray(args)) ctm = multiply(ctm, args as number[]);
        else if (fn === OPS['paintFormXObjectBegin']) {
          stack.push(ctm);
          const matrix = Array.isArray(args) ? args[0] : null;
          if (Array.isArray(matrix) && matrix.length === 6) ctm = multiply(ctm, matrix as number[]);
        } else if (fn === OPS['paintFormXObjectEnd']) ctm = stack.pop() ?? ctm;
        else if (fn === OPS['constructPath'] && Array.isArray(args)) {
          const ops = Array.isArray(args[0]) ? (args[0] as number[]) : [];
          const coords = Array.isArray(args[1]) || ArrayBuffer.isView(args[1]) ? Array.from(args[1] as ArrayLike<number>) : [];
          const shapes = shapesOfPath(OPS, ops, coords, ctm);
          pending = shapes === null ? null : [...(pending ?? []), ...shapes];
        } else if (fn !== undefined && paint.has(fn)) {
          const how = paint.get(fn) as { stroke: boolean; fill: boolean };
          for (const s of mergeOutline(pending ?? [])) {
            if (rects.length >= PAGE_GRAPHICS_MAX_RECTS) break;
            const x = round(s.x0 / viewport.width);
            const y = round(s.y0 / viewport.height);
            rects.push({ x, y, w: round(round(s.x1 / viewport.width) - x), h: round(round(s.y1 / viewport.height) - y), ...how });
          }
          pending = null;
        } else if (fn === OPS['endPath']) pending = null;
      }
      page.cleanup?.();
      pages.push({ page: n, rects });
    }
    return pages;
  } finally {
    await doc.destroy().catch(() => undefined);
  }
}
