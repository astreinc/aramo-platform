import { describe, expect, it } from 'vitest';

import { hashCanonicalizedBody } from '../lib/util/canonicalize.js';

describe('hashCanonicalizedBody', () => {
  it('produces identical hashes for objects with the same keys in different orders', () => {
    const a = { x: 1, y: 'two', z: [1, 2, 3] };
    const b = { z: [1, 2, 3], y: 'two', x: 1 };
    expect(hashCanonicalizedBody(a)).toBe(hashCanonicalizedBody(b));
  });

  it('produces different hashes for different values', () => {
    const a = { x: 1 };
    const b = { x: 2 };
    expect(hashCanonicalizedBody(a)).not.toBe(hashCanonicalizedBody(b));
  });

  it('preserves array order', () => {
    expect(hashCanonicalizedBody([1, 2, 3])).not.toBe(
      hashCanonicalizedBody([3, 2, 1]),
    );
  });

  it('handles nested objects deterministically', () => {
    const a = { outer: { b: 2, a: 1 } };
    const b = { outer: { a: 1, b: 2 } };
    expect(hashCanonicalizedBody(a)).toBe(hashCanonicalizedBody(b));
  });
});
