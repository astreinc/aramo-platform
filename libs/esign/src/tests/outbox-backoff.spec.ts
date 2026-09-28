import { describe, expect, it } from 'vitest';

import { backoffMs } from '../lib/outbox-backoff.js';

describe('backoffMs (E-Sign OC v2 delivery backoff)', () => {
  it('is 0 for a never-failed row (immediate first delivery)', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(-1)).toBe(0);
  });

  it('follows the escalating schedule 30s -> 2m -> 10m', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(120_000);
    expect(backoffMs(3)).toBe(600_000);
  });

  it('caps at 30m for sustained failure (no perpetual few-second hammering)', () => {
    expect(backoffMs(4)).toBe(1_800_000);
    expect(backoffMs(50)).toBe(1_800_000);
  });
});
