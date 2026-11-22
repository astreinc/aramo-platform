import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { extractPageGraphics } from '../index.js';

// FIELD-PARITY-1 P2-4 — the drawn rectangles and straight lines the field detector reads (empty
// boxes, ruled table cells, signature lines). Fixtures are generated with pdf-lib.

const W = 612;
const H = 792;
// A rect in points, top-left origin, from the 0..1 output.
const pts = (r: { x: number; y: number; w: number; h: number }) => ({ x: Math.round(r.x * W), y: Math.round(r.y * H), w: Math.round(r.w * W), h: Math.round(r.h * H) });

describe('extractPageGraphics', () => {
  it('reads a stroked box, a filled thin rule and a stroked line, top-left, 0..1 of the view', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    // A bordered box at (72, 600) 200×40 in PDF space (bottom-left) → top-left y = 792 - 640 = 152.
    page.drawRectangle({ x: 72, y: 600, width: 200, height: 40, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    // A table border drawn as a thin filled rectangle (what Word exports).
    page.drawRectangle({ x: 72, y: 500, width: 300, height: 0.75, color: rgb(0, 0, 0) });
    // A stroked signature line.
    page.drawLine({ start: { x: 100, y: 300 }, end: { x: 300, y: 300 }, thickness: 1, color: rgb(0, 0, 0) });
    const [g] = await extractPageGraphics(await doc.save());
    expect(g?.page).toBe(1);
    const rects = (g?.rects ?? []).map((r) => ({ ...pts(r), stroke: r.stroke, fill: r.fill }));
    expect(rects).toContainEqual({ x: 72, y: 152, w: 200, h: 40, stroke: true, fill: false });
    expect(rects.some((r) => r.fill && r.x === 72 && r.w === 300 && r.h <= 1 && Math.abs(r.y - 291) <= 1)).toBe(true);
    expect(rects.some((r) => r.stroke && r.x === 100 && r.w === 200 && r.h === 0 && r.y === 492)).toBe(true);
  });

  it('follows the transform of a translated graphics state, and skips a curve', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([W, H]);
    page.drawCircle({ x: 300, y: 400, size: 30, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    page.drawSquare({ x: 400, y: 100, size: 14, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    const [g] = await extractPageGraphics(await doc.save());
    const rects = (g?.rects ?? []).map(pts);
    expect(rects).toEqual([{ x: 400, y: 792 - 114, w: 14, h: 14 }]);
  });

  it('every page is listed; a page with no drawing has no rects', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([W, H]);
    const p2 = doc.addPage([W, H]);
    p2.drawRectangle({ x: 10, y: 10, width: 50, height: 20, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    const p3 = doc.addPage([W, H]);
    p3.setRotation(degrees(90));
    const out = await extractPageGraphics(await doc.save());
    expect(out.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(out[0]?.rects).toEqual([]);
    expect(out[1]?.rects).toHaveLength(1);
  });

  it('refuses bytes that are not a PDF', async () => {
    await expect(extractPageGraphics(new TextEncoder().encode('not a pdf'))).rejects.toBeDefined();
  });
});
