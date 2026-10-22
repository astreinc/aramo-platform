import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PersonalSignupRepository } from '@aramo/identity';

import {
  PERSONAL_SIGNUP_PURGE_DEFAULT_INTERVAL_MS,
  PersonalSignupAttemptPurgeSweeper,
  personalSignupPurgeEnabled,
  personalSignupPurgeIntervalMs,
} from '../app/platform/personal-signup-attempt-purge-sweeper.service.js';

// PO / Lead 2026-10-22 — the Personal signup-attempt cleanup sweeper: ON by default,
// one structured log line per run (both counts and both cutoffs only); abandoned
// attempts 3 days after expiry, refused attempts after 180 days.

const NOW = new Date('2026-10-22T12:00:00.000Z');
const ABANDONED_CUTOFF = new Date('2026-10-19T12:00:00.000Z');
const REFUSED_CUTOFF = new Date('2026-04-25T12:00:00.000Z');

type Result = { abandoned: number; refused: number; abandoned_cutoff: Date; refused_cutoff: Date };

function repo(result: Result | Error) {
  const purgeExpiredAttempts = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { repo: { purgeExpiredAttempts } as unknown as PersonalSignupRepository, purgeExpiredAttempts };
}

const result = (abandoned: number, refused: number): Result => ({ abandoned, refused, abandoned_cutoff: ABANDONED_CUTOFF, refused_cutoff: REFUSED_CUTOFF });

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SIGN_PERSONAL_SIGNUP_PURGE_ENABLED'];
  delete process.env['SIGN_PERSONAL_SIGNUP_PURGE_INTERVAL_MS'];
});

describe('PersonalSignupAttemptPurgeSweeper', () => {
  it('is ON unless explicitly set to 0; the interval defaults to 1 hour and ignores nonsense', () => {
    expect(personalSignupPurgeEnabled({})).toBe(true);
    expect(personalSignupPurgeEnabled({ SIGN_PERSONAL_SIGNUP_PURGE_ENABLED: '1' })).toBe(true);
    expect(personalSignupPurgeEnabled({ SIGN_PERSONAL_SIGNUP_PURGE_ENABLED: '0' })).toBe(false);
    expect(personalSignupPurgeIntervalMs({})).toBe(PERSONAL_SIGNUP_PURGE_DEFAULT_INTERVAL_MS);
    expect(PERSONAL_SIGNUP_PURGE_DEFAULT_INTERVAL_MS).toBe(3_600_000);
    expect(personalSignupPurgeIntervalMs({ SIGN_PERSONAL_SIGNUP_PURGE_INTERVAL_MS: '60000' })).toBe(60_000);
    expect(personalSignupPurgeIntervalMs({ SIGN_PERSONAL_SIGNUP_PURGE_INTERVAL_MS: '5' })).toBe(3_600_000);
    expect(personalSignupPurgeIntervalMs({ SIGN_PERSONAL_SIGNUP_PURGE_INTERVAL_MS: 'x' })).toBe(3_600_000);
  });

  it('each run applies both rules (3 days after expiry / 180 days refused) and logs exactly one line with both counts (also when nothing was deleted)', async () => {
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    for (const [abandoned, refused] of [
      [0, 0],
      [4, 2],
    ] as const) {
      log.mockClear();
      const { repo: r, purgeExpiredAttempts } = repo(result(abandoned, refused));
      const sweeper = new PersonalSignupAttemptPurgeSweeper(r);
      expect(await sweeper.tick(NOW)).toBe(abandoned + refused);
      expect(purgeExpiredAttempts).toHaveBeenCalledWith(NOW, { abandoned_days: 3, refused_days: 180 });
      expect(log).toHaveBeenCalledTimes(1);
      const line = JSON.parse(String(log.mock.calls[0]![0]));
      expect(line).toEqual({
        event: 'personal_signup_attempt_purge',
        abandoned,
        refused,
        abandoned_cutoff: ABANDONED_CUTOFF.toISOString(),
        refused_cutoff: REFUSED_CUTOFF.toISOString(),
      });
    }
  });

  it('a failed run logs a warning line and answers -1; it never throws', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { repo: r } = repo(new Error('db down'));
    expect(await new PersonalSignupAttemptPurgeSweeper(r).tick(NOW)).toBe(-1);
    expect(JSON.parse(String(warn.mock.calls[0]![0]))).toMatchObject({ event: 'personal_signup_attempt_purge', failed: true });
  });

  it('bootstrap schedules by default and not when switched off; shutdown stops further runs', async () => {
    const setI = vi.spyOn(global, 'setInterval');
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { repo: r, purgeExpiredAttempts } = repo(result(0, 0));
    const on = new PersonalSignupAttemptPurgeSweeper(r);
    on.onApplicationBootstrap();
    expect(setI).toHaveBeenCalledTimes(1);
    expect(setI.mock.calls[0]![1]).toBe(3_600_000);
    await on.onApplicationShutdown();
    expect(await on.tick(NOW)).toBe(0);
    expect(purgeExpiredAttempts).not.toHaveBeenCalled();

    setI.mockClear();
    process.env['SIGN_PERSONAL_SIGNUP_PURGE_ENABLED'] = '0';
    const off = new PersonalSignupAttemptPurgeSweeper(r);
    off.onApplicationBootstrap();
    expect(setI).not.toHaveBeenCalled();
    await off.onApplicationShutdown();
  });
});
