import { describe, expect, it } from 'vitest';

import { intersectRects, pickTargetPage, placeNewField, visibleArea, visibleRegionInPage } from './viewport';

// FIELD-PARITY-1 P0-1 (directive §3.1 R-2 / R-3) — target-page selection and new-field placement.

const LETTER = { width: 612, height: 792 };

describe('pickTargetPage (R-2)', () => {
  it('picks the page with the largest visible area', () => {
    expect(pickTargetPage([0, 120, 900], 0)).toBe(2);
    expect(pickTargetPage([500, 100, 0], 2)).toBe(0);
  });
  it('keeps the current page on a tie with the largest, else the first largest', () => {
    expect(pickTargetPage([300, 300, 0], 1)).toBe(1);
    expect(pickTargetPage([300, 300, 10], 2)).toBe(0);
  });
  it('keeps the current page when nothing is visible or there are no pages', () => {
    expect(pickTargetPage([0, 0, 0], 1)).toBe(1);
    expect(pickTargetPage([], 0)).toBe(0);
  });
});

describe('visible geometry', () => {
  const view = { left: 300, top: 86, right: 1140, bottom: 900 };
  it('intersects rects and measures the visible area', () => {
    expect(intersectRects({ left: 0, top: 0, right: 10, bottom: 10 }, { left: 20, top: 0, right: 30, bottom: 10 })).toBeNull();
    expect(visibleArea({ left: 360, top: 800, right: 1080, bottom: 1732 }, view)).toBe(720 * 100);
    expect(visibleArea({ left: 360, top: 1000, right: 1080, bottom: 1932 }, view)).toBe(0);
  });
  it('maps the visible part of a page to PDF points (top-left frame)', () => {
    // 720px-wide render of a 612pt page → scale 720/612; the page top is 400px above the view top.
    const s = 720 / 612;
    const page = { left: 360, top: view.top - 400, right: 1080, bottom: view.top - 400 + 792 * s };
    const r = visibleRegionInPage(page, view, LETTER);
    expect(r).not.toBeNull();
    expect(r?.left).toBeCloseTo(0);
    expect(r?.right).toBeCloseTo(612);
    expect(r?.top).toBeCloseTo(400 / s);
    expect(r?.bottom).toBeCloseTo(792);
    expect(visibleRegionInPage({ left: 360, top: 1000, right: 1080, bottom: 1932 }, view, LETTER)).toBeNull();
  });
});

describe('placeNewField (R-3)', () => {
  const size = { width: 120, height: 18 };
  it('without a visible region keeps the original spot (72pt in, 144pt below the top, cascading)', () => {
    expect(placeNewField({ page: LETTER, visible: null, size, cascade: 0 })).toEqual({ x: 72, y: 792 - 144 - 18 });
    expect(placeNewField({ page: LETTER, visible: null, size, cascade: 2 })).toEqual({ x: 96, y: 792 - 168 - 18 });
    // The cascade cycles every 10 fields.
    expect(placeNewField({ page: LETTER, visible: null, size, cascade: 10 })).toEqual({ x: 72, y: 792 - 144 - 18 });
  });
  it('lands at the top-left of the visible region plus the inset, in PDF-native (bottom-left) y', () => {
    const visible = { left: 0, top: 500, right: 612, bottom: 792 };
    expect(placeNewField({ page: LETTER, visible, size, cascade: 0 })).toEqual({ x: 72, y: 792 - 572 - 18 });
    expect(placeNewField({ page: LETTER, visible, size, cascade: 1 })).toEqual({ x: 84, y: 792 - 584 - 18 });
  });
  it('stays inside a small visible region', () => {
    const visible = { left: 0, top: 740, right: 612, bottom: 792 };
    const { y } = placeNewField({ page: LETTER, visible, size, cascade: 9 });
    const top = 792 - y - 18;
    expect(top).toBeGreaterThanOrEqual(740);
    expect(top + 18).toBeLessThanOrEqual(792);
  });
  it('is always clamped to the page bounds', () => {
    const big = { width: 700, height: 900 };
    expect(placeNewField({ page: LETTER, visible: { left: 0, top: 0, right: 612, bottom: 792 }, size: big, cascade: 3 })).toEqual({ x: 0, y: 0 });
    const edge = placeNewField({ page: LETTER, visible: { left: 560, top: 0, right: 612, bottom: 300 }, size, cascade: 0 });
    expect(edge.x).toBe(612 - 120);
  });
});
