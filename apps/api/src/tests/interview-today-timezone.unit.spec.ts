import { describe, expect, it } from 'vitest';

import { isoDateInTimeZone } from '@aramo/common';
import { isInterviewToday } from '@aramo/client-selection';

// Deliberate record of the "interview today" semantic shared by My Desk and Talent 360.
//
// Both surfaces now decide today-ness through the ONE canonical derivation —
// `isInterviewToday` (libs/client-selection): a LIVE interview whose scheduled_at civil
// date EQUALS the request-instant civil date, BOTH resolved in the app timezone
// (ARAMO_APP_TIME_ZONE, default America/New_York) — NOT the UTC calendar day, and NOT a
// rolling 24-hour window. This spec pins the production boundary behaviour against that
// canonical helper (no local re-derivation); a regression to UTC-day/24h fails here.
describe('interview-today semantic — canonical isInterviewToday (America/New_York civil day)', () => {
  const TZ = 'America/New_York';
  const isToday = (requestMs: number, interviewMs: number): boolean =>
    isInterviewToday({ state: 'SCHEDULED', scheduled_at_ms: interviewMs, now_ms: requestMs, time_zone: TZ });

  it('NOT today across the NY midnight boundary: request 23:00 EDT (Sep 30), interview 01:00 EDT (Oct 1)', () => {
    const request = Date.parse('2026-10-01T03:00:00Z'); // Sep 30 23:00 EDT
    const interview = Date.parse('2026-10-01T05:00:00Z'); // Oct 1 01:00 EDT
    expect(isoDateInTimeZone(request, TZ)).toBe('2026-09-30');
    expect(isoDateInTimeZone(interview, TZ)).toBe('2026-10-01');
    expect(isToday(request, interview)).toBe(false);
  });

  it('today within the same NY civil day: request 12:00 EDT (Oct 1), interview 15:00 EDT (Oct 1)', () => {
    const request = Date.parse('2026-10-01T16:00:00Z'); // Oct 1 12:00 EDT
    const interview = Date.parse('2026-10-01T19:00:00Z'); // Oct 1 15:00 EDT
    expect(isToday(request, interview)).toBe(true);
  });

  it('the same two instants would BOTH read as "today" under a naive UTC-day rule — which the canonical semantic deliberately does NOT use', () => {
    const request = Date.parse('2026-10-01T03:00:00Z');
    const interview = Date.parse('2026-10-01T05:00:00Z');
    expect(isoDateInTimeZone(request, 'UTC')).toBe('2026-10-01');
    expect(isoDateInTimeZone(interview, 'UTC')).toBe('2026-10-01');
    // ...yet the canonical helper (app timezone) correctly says NOT today.
    expect(isToday(request, interview)).toBe(false);
  });
});
