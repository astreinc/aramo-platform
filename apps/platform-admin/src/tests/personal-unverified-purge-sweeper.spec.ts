import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonalSignupRepository } from '@aramo/identity';

import {
  PERSONAL_UNVERIFIED_PURGE_DEFAULT_INTERVAL_MS,
  PersonalUnverifiedPurgeSweeper,
  personalUnverifiedPurgeEnabled,
  personalUnverifiedPurgeIntervalMs,
} from '../app/platform/personal-unverified-purge-sweeper.service.js';

// PO 2026-10-22 — the unverified Personal signup purge sweeper: ON by default,
// one structured log line per run (counts and the cutoff only), 3-day window.

const NOW = new Date('2026-10-22T12:00:00.000Z');
const CUTOFF = new Date('2026-10-19T12:00:00.000Z');

function repo(result: { deleted: number; cutoff: Date } | Error) {
  const purgeUnverified = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { repo: { purgeUnverified } as unknown as PersonalSignupRepository, purgeUnverified };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SIGN_PERSONAL_UNVERIFIED_PURGE_ENABLED'];
  delete process.env['SIGN_PERSONAL_UNVERIFIED_PURGE_INTERVAL_MS'];
});

describe('PersonalUnverifiedPurgeSweeper', () => {
  it('is ON unless explicitly set to 0; the interval defaults to 1 hour and ignores nonsense', () => {
    expect(personalUnverifiedPurgeEnabled({})).toBe(true);
    expect(personalUnverifiedPurgeEnabled({ SIGN_PERSONAL_UNVERIFIED_PURGE_ENABLED: '1' })).toBe(true);
    expect(personalUnverifiedPurgeEnabled({ SIGN_PERSONAL_UNVERIFIED_PURGE_ENABLED: '0' })).toBe(false);
    expect(personalUnverifiedPurgeIntervalMs({})).toBe(PERSONAL_UNVERIFIED_PURGE_DEFAULT_INTERVAL_MS);
    expect(PERSONAL_UNVERIFIED_PURGE_DEFAULT_INTERVAL_MS).toBe(3_600_000);
    expect(personalUnverifiedPurgeIntervalMs({ SIGN_PERSONAL_UNVERIFIED_PURGE_INTERVAL_MS: '60000' })).toBe(60_000);
    expect(personalUnverifiedPurgeIntervalMs({ SIGN_PERSONAL_UNVERIFIED_PURGE_INTERVAL_MS: '5' })).toBe(3_600_000);
    expect(personalUnverifiedPurgeIntervalMs({ SIGN_PERSONAL_UNVERIFIED_PURGE_INTERVAL_MS: 'x' })).toBe(3_600_000);
  });

  it('each run purges with the 3-day window and logs exactly one structured line (also when nothing was deleted)', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    for (const deleted of [0, 4]) {
      log.mockClear();
      const { repo: r, purgeUnverified } = repo({ deleted, cutoff: CUTOFF });
      const sweeper = new PersonalUnverifiedPurgeSweeper(r);
      expect(await sweeper.tick(NOW)).toBe(deleted);
      expect(purgeUnverified).toHaveBeenCalledWith(NOW, 3);
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(log.mock.calls[0]![0]));
      expect(line).toEqual({ event: 'personal_unverified_signup_purge', deleted, cutoff: CUTOFF.toISOString() });
    }
  });

  it('a failed run logs a warning line and answers -1; it never throws', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { repo: r } = repo(new Error('db down'));
    expect(await new PersonalUnverifiedPurgeSweeper(r).tick(NOW)).toBe(-1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ event: 'personal_unverified_signup_purge', failed: true });
  });

  it('bootstrap schedules by default and not when switched off; shutdown stops further runs', async () => {
    const setI = vi.spyOn(global, 'setInterval');
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { repo: r, purgeUnverified } = repo({ deleted: 0, cutoff: CUTOFF });
    const on = new PersonalUnverifiedPurgeSweeper(r);
    on.onApplicationBootstrap();
    expect(setI).toHaveBeenCalledTimes(1);
    expect(setI.mock.calls[0]![1]).toBe(3_600_000);
    await on.onApplicationShutdown();
    expect(await on.tick(NOW)).toBe(0);
    expect(purgeUnverified).not.toHaveBeenCalled();

    setI.mockClear();
    process.env['SIGN_PERSONAL_UNVERIFIED_PURGE_ENABLED'] = '0';
    const off = new PersonalUnverifiedPurgeSweeper(r);
    off.onApplicationBootstrap();
    expect(setI).not.toHaveBeenCalled();
    await off.onApplicationShutdown();
  });
});
