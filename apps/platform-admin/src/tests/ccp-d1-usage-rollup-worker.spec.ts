import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  USAGE_ROLLUP_DEFAULT_INTERVAL_MS,
  UsageRollupWorker,
  usageRollupEnabled,
  usageRollupIntervalMs,
} from '../app/platform/usage-rollup-worker.service.js';

// CCP-D1 (PBD §5.4 row D1, recovery "disable the worker") — the usage roll-up worker is OFF by
// default: only CCP_USAGE_ROLLUP_ENABLED=1 arms it. A tick never throws.

describe('CCP-D1 — usage roll-up worker gating', () => {
  const saved = { e: process.env['CCP_USAGE_ROLLUP_ENABLED'], i: process.env['CCP_USAGE_ROLLUP_INTERVAL_MS'] };
  afterEach(() => {
    for (const [k, v] of [['CCP_USAGE_ROLLUP_ENABLED', saved.e], ['CCP_USAGE_ROLLUP_INTERVAL_MS', saved.i]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    vi.useRealTimers();
  });

  it('D1-OFF-1 unset (or anything but "1") ⇒ off: no interval is armed and the service is never called', async () => {
    const usage = { run: vi.fn() };
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1']) {
      if (v === undefined) delete process.env['CCP_USAGE_ROLLUP_ENABLED'];
      else process.env['CCP_USAGE_ROLLUP_ENABLED'] = v;
      expect(usageRollupEnabled()).toBe(false);
      const w = new UsageRollupWorker(usage as never);
      w.onApplicationBootstrap();
      expect(w.scheduled).toBe(false);
      await w.onApplicationShutdown();
    }
    expect(usage.run).not.toHaveBeenCalled();
  });

  it('D1-OFF-2 CCP_USAGE_ROLLUP_ENABLED=1 arms the interval (default 1 hour); shutdown clears it', async () => {
    vi.useFakeTimers();
    process.env['CCP_USAGE_ROLLUP_ENABLED'] = '1';
    delete process.env['CCP_USAGE_ROLLUP_INTERVAL_MS'];
    const usage = { run: vi.fn(async () => ({ status: 'COMPLETED', metrics: [] })) };
    const w = new UsageRollupWorker(usage as never);
    w.onApplicationBootstrap();
    expect(w.scheduled).toBe(true);
    await vi.advanceTimersByTimeAsync(USAGE_ROLLUP_DEFAULT_INTERVAL_MS - 1);
    expect(usage.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(usage.run).toHaveBeenCalledTimes(1);
    await w.onApplicationShutdown();
    expect(w.scheduled).toBe(false);
    await vi.advanceTimersByTimeAsync(USAGE_ROLLUP_DEFAULT_INTERVAL_MS * 2);
    expect(usage.run).toHaveBeenCalledTimes(1);
  });

  it('D1-OFF-3 the interval: default 1 hour; below 1 s or not a number ⇒ default', () => {
    expect(usageRollupIntervalMs({})).toBe(3_600_000);
    expect(usageRollupIntervalMs({ CCP_USAGE_ROLLUP_INTERVAL_MS: '60000' })).toBe(60_000);
    expect(usageRollupIntervalMs({ CCP_USAGE_ROLLUP_INTERVAL_MS: '999' })).toBe(3_600_000);
    expect(usageRollupIntervalMs({ CCP_USAGE_ROLLUP_INTERVAL_MS: 'soon' })).toBe(3_600_000);
  });

  it('D1-OFF-4 a failing run is logged, never thrown; ticks never overlap', async () => {
    let release: () => void = () => undefined;
    const usage = {
      run: vi
        .fn()
        .mockRejectedValueOnce(new Error('db down'))
        .mockImplementationOnce(() => new Promise((r) => (release = () => r({ status: 'COMPLETED', metrics: [] })))),
    };
    const w = new UsageRollupWorker(usage as never);
    expect(await w.tick()).toBe('FAILED');
    const slow = w.tick();
    expect(await w.tick()).toBe('SKIPPED');
    release();
    expect(await slow).toBe('COMPLETED');
    await w.onApplicationShutdown();
    expect(await w.tick()).toBe('SKIPPED');
  });
});
