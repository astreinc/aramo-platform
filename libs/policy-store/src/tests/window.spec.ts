import { describe, expect, it } from 'vitest';

import { isEffectiveAt, selectEffectiveAt } from '../lib/window.js';

// Unit coverage for point-in-time window selection (§D17b). No database —
// the boundary semantics (from inclusive, to exclusive) are proved here.

const T = (ms: number): Date => new Date(ms);

describe('isEffectiveAt — from inclusive, to exclusive', () => {
  const closed = { effective_from: T(100), effective_to: T(200) };
  const open = { effective_from: T(100), effective_to: null };

  it('is false strictly before effective_from', () => {
    expect(isEffectiveAt(closed, T(99))).toBe(false);
  });

  it('is true AT effective_from (lower bound inclusive)', () => {
    expect(isEffectiveAt(closed, T(100))).toBe(true);
  });

  it('is true within the window', () => {
    expect(isEffectiveAt(closed, T(150))).toBe(true);
  });

  it('is false AT effective_to (upper bound exclusive)', () => {
    expect(isEffectiveAt(closed, T(200))).toBe(false);
  });

  it('is false after effective_to', () => {
    expect(isEffectiveAt(closed, T(201))).toBe(false);
  });

  it('a null effective_to is open-ended', () => {
    expect(isEffectiveAt(open, T(100))).toBe(true);
    expect(isEffectiveAt(open, T(10_000))).toBe(true);
  });
});

describe('selectEffectiveAt — single active version across a handoff', () => {
  // Two adjacent, non-overlapping windows: v1 [100,200), v2 [200, open).
  const v1 = { id: 'v1', effective_from: T(100), effective_to: T(200) };
  const v2 = { id: 'v2', effective_from: T(200), effective_to: null };
  const versions = [v1, v2];

  it('returns undefined before the first window', () => {
    expect(selectEffectiveAt(versions, T(50))).toBeUndefined();
  });

  it('selects v1 inside its window', () => {
    expect(selectEffectiveAt(versions, T(100))?.id).toBe('v1');
    expect(selectEffectiveAt(versions, T(199))?.id).toBe('v1');
  });

  it('hands off to v2 exactly at the shared boundary (200)', () => {
    // v1.effective_to is exclusive, v2.effective_from is inclusive — the
    // instant belongs to v2, and there is never a gap or an overlap.
    expect(selectEffectiveAt(versions, T(200))?.id).toBe('v2');
  });

  it('selects v2 in its open-ended tail', () => {
    expect(selectEffectiveAt(versions, T(9_999))?.id).toBe('v2');
  });
});
