import { describe, expect, it } from 'vitest';

import {
  isInterviewToday,
  isLiveInterviewState,
  LIVE_INTERVIEW_STATES,
} from '../lib/interview-today.js';

// Canonical "interview today" semantic: a LIVE (non-terminal) interview whose
// scheduled_at civil date equals the request-instant civil date, both in the app
// timezone — never the UTC day, never a rolling 24h window.
const TZ = 'America/New_York';
const d = (iso: string): number => Date.parse(iso);
const NOW = d('2026-10-05T12:00:00-04:00'); // Oct 5 noon EDT

describe('LIVE_INTERVIEW_STATES', () => {
  it('is exactly the non-terminal states { SCHEDULED, RESCHEDULED }', () => {
    expect([...LIVE_INTERVIEW_STATES].sort()).toEqual(['RESCHEDULED', 'SCHEDULED']);
    expect(isLiveInterviewState('SCHEDULED')).toBe(true);
    expect(isLiveInterviewState('RESCHEDULED')).toBe(true);
    expect(isLiveInterviewState('COMPLETED')).toBe(false);
    expect(isLiveInterviewState('CANCELED')).toBe(false);
    expect(isLiveInterviewState('NO_SHOW')).toBe(false);
    expect(isLiveInterviewState(null)).toBe(false);
  });
});

describe('isInterviewToday', () => {
  const today = (state: string, scheduledIso: string): boolean =>
    isInterviewToday({ state, scheduled_at_ms: d(scheduledIso), now_ms: NOW, time_zone: TZ });

  it('SCHEDULED today → true', () => {
    expect(today('SCHEDULED', '2026-10-05T15:00:00-04:00')).toBe(true);
  });

  it('RESCHEDULED today → true', () => {
    expect(today('RESCHEDULED', '2026-10-05T09:00:00-04:00')).toBe(true);
  });

  it('yesterday → false', () => {
    expect(today('SCHEDULED', '2026-10-04T15:00:00-04:00')).toBe(false);
  });

  it('tomorrow → false', () => {
    expect(today('SCHEDULED', '2026-10-06T09:00:00-04:00')).toBe(false);
  });

  it('terminal interview state today → false', () => {
    expect(today('COMPLETED', '2026-10-05T15:00:00-04:00')).toBe(false);
    expect(today('CANCELED', '2026-10-05T15:00:00-04:00')).toBe(false);
    expect(today('NO_SHOW', '2026-10-05T15:00:00-04:00')).toBe(false);
  });

  it('timezone boundary: 23:00 the prior NY day (next UTC day) is NOT today', () => {
    // request 23:00 EDT Oct 5; a scheduled instant at 01:00 EDT Oct 6 is the next civil day.
    const req = d('2026-10-06T03:00:00Z'); // Oct 5 23:00 EDT
    const iv = d('2026-10-06T05:00:00Z'); // Oct 6 01:00 EDT
    expect(
      isInterviewToday({ state: 'SCHEDULED', scheduled_at_ms: iv, now_ms: req, time_zone: TZ }),
    ).toBe(false);
  });

  it('null scheduled_at → false', () => {
    expect(isInterviewToday({ state: 'SCHEDULED', scheduled_at_ms: null, now_ms: NOW, time_zone: TZ })).toBe(false);
  });
});
