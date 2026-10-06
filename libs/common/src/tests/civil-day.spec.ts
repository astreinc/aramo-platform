import { describe, expect, it } from 'vitest';

import {
  agingDaysInTimeZone,
  civilDayUtcMs,
  isoDateInTimeZone,
} from '../lib/util/civil-day.js';

// Canonical civil-day math (directive §38). EDT is UTC-4 in September, so instants
// near midnight UTC fall on the PRIOR civil day locally — the exact trap §38 forbids
// (comparing UTC strings/absolute-ms to local dates). These cases pin the semantic
// that My Desk urgency/aging, client waiting age, and interview-today all derive from.
const TZ = 'America/New_York';

// 2026-09-29 12:00 EDT (a mid-day "now" on Tue Sep 29).
const NOW = Date.parse('2026-09-29T16:00:00Z');

describe('isoDateInTimeZone', () => {
  it('formats the app-timezone civil date as YYYY-MM-DD', () => {
    expect(isoDateInTimeZone(NOW, TZ)).toBe('2026-09-29');
  });

  it('resolves an instant that is the NEXT day in UTC but still today locally', () => {
    // 2026-09-30T02:00Z = 2026-09-29 22:00 EDT → civil Sep 29.
    expect(isoDateInTimeZone(Date.parse('2026-09-30T02:00:00Z'), TZ)).toBe('2026-09-29');
  });
});

describe('civilDayUtcMs', () => {
  it('anchors an instant to UTC-midnight of its civil date', () => {
    expect(civilDayUtcMs(NOW, TZ)).toBe(Date.parse('2026-09-29T00:00:00Z'));
    expect(civilDayUtcMs(Date.parse('2026-09-30T02:00:00Z'), TZ)).toBe(
      Date.parse('2026-09-29T00:00:00Z'),
    );
  });
});

describe('agingDaysInTimeZone', () => {
  it('a same civil-day instant is 0 days', () => {
    expect(agingDaysInTimeZone(Date.parse('2026-09-29T13:00:00Z'), NOW, TZ)).toBe(0);
  });

  it('counts whole civil days across a month boundary (Sep 21 → Sep 29 = 8)', () => {
    expect(agingDaysInTimeZone(Date.parse('2026-09-21T15:00:00Z'), NOW, TZ)).toBe(8);
  });

  it('never returns negative for a future instant', () => {
    expect(agingDaysInTimeZone(Date.parse('2026-10-05T12:00:00Z'), NOW, TZ)).toBe(0);
  });

  it('counts CIVIL days across the US spring-forward DST boundary, not 24h slabs', () => {
    // 2026-03-08 is spring-forward in America/New_York (02:00 EST → 03:00 EDT; the
    // day is only 23 wall-clock hours). Mar 7 12:00 EST → Mar 9 12:00 EDT is 2 civil
    // days; absolute-ms division (47h) would wrongly yield 1.
    const since = Date.parse('2026-03-07T17:00:00Z'); // Mar 7 12:00 EST
    const now = Date.parse('2026-03-09T16:00:00Z'); // Mar 9 12:00 EDT
    expect(agingDaysInTimeZone(since, now, TZ)).toBe(2);
  });
});
