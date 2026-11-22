import { describe, expect, it } from 'vitest';

import { alignBoxes, boundsOf, clampGroupDelta, distributeBoxes, intersects, rectFromPoints, sameSizeBoxes, snapMove, snapResize, type SnapOptions } from './arrange';

// FIELD-PARITY-1 §5 P2-2 / P2-3 — pure arrange and snap geometry (top-left frame, points).

const b = (x: number, y: number, width = 100, height = 20) => ({ x, y, width, height });
const EDGES: SnapOptions = { edges: true, grid: null, threshold: 5 };

describe('selection geometry', () => {
  it('bounds, a box from two points in any direction, and touch-to-select', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([b(10, 10), b(50, 100, 20, 30)])).toEqual({ x: 10, y: 10, width: 100, height: 120 });
    expect(rectFromPoints({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 60 });
    expect(intersects(b(0, 0), b(99, 19, 5, 5))).toBe(true);
    expect(intersects(b(0, 0), b(100, 0, 5, 5))).toBe(false);
    expect(intersects(b(0, 0), b(0, 20, 5, 5))).toBe(false);
  });
});

describe('align / distribute / same size', () => {
  const boxes = [b(10, 10, 100, 20), b(40, 60, 50, 30), b(25, 120, 200, 10)];
  it.each([
    ['left', [10, 10, 10], 'x'],
    ['right', [125, 175, 25], 'x'],
    ['hcenter', [67.5, 92.5, 17.5], 'x'],
    ['top', [10, 10, 10], 'y'],
    ['bottom', [110, 100, 120], 'y'],
    ['vcenter', [60, 55, 65], 'y'],
  ] as const)('align %s', (edge, want, axis) => {
    expect(alignBoxes(boxes, edge).map((x) => x[axis])).toEqual(want);
  });

  it('align needs two boxes', () => {
    expect(alignBoxes([b(5, 5)], 'left')).toEqual([b(5, 5)]);
  });

  it('distribute keeps the outermost and equalises the gaps (order of the input is kept)', () => {
    const across = distributeBoxes([b(0, 0, 10), b(90, 0, 10), b(20, 0, 30)], 'horizontal');
    // span 0..100, widths 50 → gap 25: 0, 35 (the 30-wide one), 90.
    expect(across.map((x) => x.x)).toEqual([0, 90, 35]);
    const down = distributeBoxes([b(0, 0, 10, 10), b(0, 15, 10, 10), b(0, 100, 10, 10)], 'vertical');
    expect(down.map((x) => x.y)).toEqual([0, 50, 100]);
    expect(distributeBoxes([b(0, 0), b(9, 9)], 'horizontal')).toEqual([b(0, 0), b(9, 9)]);
  });

  it('same width / height copies the anchor and keeps each top-left corner', () => {
    expect(sameSizeBoxes([b(1, 2, 10, 20), b(3, 4, 30, 40)], b(0, 0, 77, 88), 'width')).toEqual([b(1, 2, 77, 20), b(3, 4, 77, 40)]);
    expect(sameSizeBoxes([b(1, 2, 10, 20)], b(0, 0, 77, 88), 'height')).toEqual([b(1, 2, 10, 88)]);
  });
});

describe('snap', () => {
  const other = b(100, 200, 100, 20);
  it('a left edge within reach snaps to another field’s left edge, with a vertical guide', () => {
    const r = snapMove(b(103, 400), [other], EDGES);
    expect(r).toMatchObject({ dx: -3, dy: 0 });
    expect(r.xs).toContain(100);
    expect(r.ys).toEqual([]);
  });
  it('centres and opposite edges snap too (nearest wins)', () => {
    expect(snapMove(b(148, 400, 4, 4), [other], EDGES).dx).toBe(0); // centre 150 already on 150
    expect(snapMove(b(203, 400, 40, 4), [other], EDGES).dx).toBe(-3); // left 203 → right edge 200
    expect(snapMove(b(300, 222), [other], EDGES)).toMatchObject({ dy: -2 }); // top 222 → bottom 220
  });
  it('out of reach: no snap and no guides; edges off and no grid: nothing', () => {
    expect(snapMove(b(110, 400), [other], EDGES)).toEqual({ dx: 0, dy: 0, xs: [], ys: [] });
    expect(snapMove(b(103, 400), [other], { ...EDGES, edges: false })).toEqual({ dx: 0, dy: 0, xs: [], ys: [] });
  });
  it('with the grid on and no edge in reach, the top-left corner snaps to the grid (no guide)', () => {
    const r = snapMove(b(33, 47), [], { edges: true, grid: 10, threshold: 5 });
    expect(r).toEqual({ dx: -3, dy: 3, xs: [], ys: [] });
  });
  it('resize snaps the right and bottom edges only', () => {
    const r = snapResize(b(0, 0, 197, 216), [other], EDGES);
    expect(r).toMatchObject({ dx: 3, dy: 4 });
    expect(r.xs).toEqual([200]);
    expect(r.ys).toEqual([220]);
  });
});

describe('clampGroupDelta', () => {
  const page = { width: 612, height: 792 };
  it('stops the whole group at the first page edge it reaches', () => {
    const items = [
      { box: b(10, 10), page },
      { box: b(500, 700), page },
    ];
    expect(clampGroupDelta(items, -50, 500)).toEqual({ dx: -10, dy: 72 });
    expect(clampGroupDelta(items, 5, 5)).toEqual({ dx: 5, dy: 5 });
  });
});
