import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RateLimitService } from '../app/intake/rate-limit.service.js';

// §1.10 — rate-limit trip + reset. Time is driven by the nowMs parameter so the
// test is deterministic (no real clock).
describe('RateLimitService', () => {
  const HOUR = 60 * 60 * 1000;
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env['INTAKE_RATE_LIMIT_PER_HOUR'];
    process.env['INTAKE_RATE_LIMIT_PER_HOUR'] = '5';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env['INTAKE_RATE_LIMIT_PER_HOUR'];
    else process.env['INTAKE_RATE_LIMIT_PER_HOUR'] = saved;
  });

  it('allows up to capacity, then trips the 6th', () => {
    const rl = new RateLimitService();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(rl.tryConsume('1.2.3.4', t0)).toBe(true);
    }
    expect(rl.tryConsume('1.2.3.4', t0)).toBe(false);
  });

  it('refills after the one-hour window (reset)', () => {
    const rl = new RateLimitService();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) rl.tryConsume('9.9.9.9', t0);
    expect(rl.tryConsume('9.9.9.9', t0)).toBe(false);
    expect(rl.tryConsume('9.9.9.9', t0 + HOUR)).toBe(true);
  });

  it('keys per IP — one IP tripping does not affect another', () => {
    const rl = new RateLimitService();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) rl.tryConsume('a', t0);
    expect(rl.tryConsume('a', t0)).toBe(false);
    expect(rl.tryConsume('b', t0)).toBe(true);
  });
});
