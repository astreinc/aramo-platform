import { describe, expect, it } from 'vitest';

import { composeInstants, durationMinutesBetween, instantToZonedWallClock } from './calendar-meeting-tz';

// M365-SCHED-1 PR 1B FIX_NOW-1/2 — wall-clock + IANA zone → unambiguous ISO-8601
// instants (offset-bearing), DST gaps/overlaps surfaced, rollovers via instant math.

describe('composeInstants', () => {
  it('produces OFFSET-BEARING ISO-8601 instants (not a bare local string)', () => {
    const r = composeInstants('2026-11-03', '10:00', 30, 'America/New_York');
    expect(r.problem).toBe('none');
    // standard time in November → -05:00; the string is a true instant
    expect(r.startIso).toBe('2026-11-03T10:00:00-05:00');
    expect(r.endIso).toBe('2026-11-03T10:30:00-05:00');
    expect(r.startIso).toMatch(/[+-]\d{2}:\d{2}$|Z$/); // unambiguous
  });

  it('honors DST — the same wall clock in July is -04:00 (EDT)', () => {
    const r = composeInstants('2026-07-01', '10:00', 60, 'America/New_York');
    expect(r.startIso).toBe('2026-07-01T10:00:00-04:00');
    expect(r.endIso).toBe('2026-07-01T11:00:00-04:00');
  });

  it('UTC zone → +00:00', () => {
    expect(composeInstants('2026-11-03', '10:00', 30, 'UTC').startIso).toBe('2026-11-03T10:00:00+00:00');
  });

  it('end rolls across midnight / month / year via instant math', () => {
    expect(composeInstants('2026-12-31', '23:45', 30, 'UTC').endIso).toBe('2027-01-01T00:15:00+00:00');
    expect(composeInstants('2026-11-30', '23:45', 30, 'UTC').endIso).toBe('2026-12-01T00:15:00+00:00');
  });

  it('DST spring-forward nonexistent local time is flagged, not silently shifted', () => {
    // US 2026 spring-forward: 2026-03-08, 02:00 → 03:00; 02:30 does not exist.
    const r = composeInstants('2026-03-08', '02:30', 30, 'America/New_York');
    expect(r.problem).toBe('nonexistent');
  });

  it('DST fall-back ambiguous local time is flagged', () => {
    // US 2026 fall-back: 2026-11-01, 02:00 → 01:00; 01:30 occurs twice.
    const r = composeInstants('2026-11-01', '01:30', 30, 'America/New_York');
    expect(r.problem).toBe('ambiguous');
  });
});

describe('instantToZonedWallClock', () => {
  it('renders a stored UTC instant as the wall clock of the SELECTED zone (not UTC)', () => {
    // 2026-11-03T15:00:00Z is 10:00 in New York (EST, -05:00).
    expect(instantToZonedWallClock('2026-11-03T15:00:00.000Z', 'America/New_York')).toEqual({
      date: '2026-11-03',
      time: '10:00',
    });
  });
});

describe('durationMinutesBetween', () => {
  it('computes minutes between two instants', () => {
    expect(durationMinutesBetween('2026-11-03T15:00:00.000Z', '2026-11-03T15:45:00.000Z')).toBe(45);
  });
});
