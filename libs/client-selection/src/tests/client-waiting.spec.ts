import { describe, expect, it } from 'vitest';

import {
  CLIENT_WAITING_STATE,
  deriveClientWaitingDays,
  isClientWaitingState,
} from '../lib/client-waiting.js';

// Canonical "waiting on client" age. Whole CIVIL days in the app timezone, gated to
// CLIENT_REVIEW. Waiting age ONLY — no SLA/deadline semantic.
const TZ = 'America/New_York';
const d = (iso: string): number => Date.parse(iso);

describe('deriveClientWaitingDays', () => {
  it('same civil day → 0', () => {
    expect(
      deriveClientWaitingDays({
        selection_state: 'CLIENT_REVIEW',
        since_ms: d('2026-10-05T09:00:00-04:00'),
        now_ms: d('2026-10-05T18:00:00-04:00'),
        time_zone: TZ,
      }),
    ).toBe(0);
  });

  it('next civil day → 1', () => {
    expect(
      deriveClientWaitingDays({
        selection_state: 'CLIENT_REVIEW',
        since_ms: d('2026-10-04T23:00:00-04:00'),
        now_ms: d('2026-10-05T01:00:00-04:00'),
        time_zone: TZ,
      }),
    ).toBe(1);
  });

  it('multi-day → whole civil days', () => {
    expect(
      deriveClientWaitingDays({
        selection_state: 'CLIENT_REVIEW',
        since_ms: d('2026-09-21T15:00:00Z'),
        now_ms: d('2026-09-29T16:00:00Z'),
        time_zone: TZ,
      }),
    ).toBe(8);
  });

  it('timezone boundary: a since-instant that is the next UTC day but same local day → 0', () => {
    // 2026-10-06T02:00Z = 2026-10-05 22:00 EDT; now 2026-10-05 23:00 EDT. Same civil day.
    expect(
      deriveClientWaitingDays({
        selection_state: 'CLIENT_REVIEW',
        since_ms: d('2026-10-06T02:00:00Z'),
        now_ms: d('2026-10-06T03:00:00Z'),
        time_zone: TZ,
      }),
    ).toBe(0);
  });

  it('DST boundary (US spring-forward) counts civil days, not 24h slabs', () => {
    // Mar 7 12:00 EST → Mar 9 12:00 EDT = 2 civil days (the day in between is 23h).
    expect(
      deriveClientWaitingDays({
        selection_state: 'CLIENT_REVIEW',
        since_ms: d('2026-03-07T17:00:00Z'),
        now_ms: d('2026-03-09T16:00:00Z'),
        time_zone: TZ,
      }),
    ).toBe(2);
  });

  it('non-CLIENT_REVIEW states never produce a waiting age', () => {
    for (const state of ['INTERVIEW', 'SELECTED', 'DECLINED', 'WITHDRAWN', null]) {
      expect(
        deriveClientWaitingDays({
          selection_state: state,
          since_ms: d('2026-09-21T15:00:00Z'),
          now_ms: d('2026-09-29T16:00:00Z'),
          time_zone: TZ,
        }),
      ).toBeNull();
    }
  });

  it('null / unparseable since → null even in CLIENT_REVIEW', () => {
    expect(
      deriveClientWaitingDays({ selection_state: 'CLIENT_REVIEW', since_ms: null, now_ms: Date.now(), time_zone: TZ }),
    ).toBeNull();
    expect(
      deriveClientWaitingDays({ selection_state: 'CLIENT_REVIEW', since_ms: Number.NaN, now_ms: Date.now(), time_zone: TZ }),
    ).toBeNull();
  });

  it('CLIENT_WAITING_STATE is CLIENT_REVIEW and isClientWaitingState agrees', () => {
    expect(CLIENT_WAITING_STATE).toBe('CLIENT_REVIEW');
    expect(isClientWaitingState('CLIENT_REVIEW')).toBe(true);
    expect(isClientWaitingState('INTERVIEW')).toBe(false);
    expect(isClientWaitingState(null)).toBe(false);
  });
});
