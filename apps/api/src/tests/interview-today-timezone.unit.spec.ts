import { describe, expect, it } from 'vitest';

import { isoDateInTimeZone } from '../my-desk/my-desk.derivation.js';

// Deliberate record of the "interview today" semantic shared by My Desk and Talent 360.
//
// Both surfaces decide today-ness identically: an interview counts as "today" iff its
// scheduled_at civil date EQUALS the REQUEST-instant civil date, BOTH resolved in the app
// timezone (ARAMO_APP_TIME_ZONE, default America/New_York) — NOT the UTC calendar day, and
// NOT a rolling 24-hour window. `isoDateInTimeZone` is that civil-date primitive (Talent 360
// carries a byte-identical private copy, `isoDate`).
//
// This is why a relative wall-clock fixture (`scheduled_at = NOW + 3h` to mean "today") is
// wrong near the app-day boundary: in the 21:00–24:00 ET window, NOW+3h rolls into the next
// NY civil day and is correctly NOT "today". The instants below are the exact post-mortem
// cases from that flake; they pin the production behavior as intentional so a future change
// to UTC-day or 24h-window semantics fails loudly here.
describe('interview-today semantic — America/New_York civil-day match (not UTC, not 24h)', () => {
  const TZ = 'America/New_York';
  const isToday = (requestMs: number, interviewMs: number): boolean =>
    isoDateInTimeZone(interviewMs, TZ) === isoDateInTimeZone(requestMs, TZ);

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
    expect(isoDateInTimeZone(request, TZ)).toBe('2026-10-01');
    expect(isoDateInTimeZone(interview, TZ)).toBe('2026-10-01');
    expect(isToday(request, interview)).toBe(true);
  });

  it('the same two instants would BOTH read as "today" under a naive UTC-day rule — which production deliberately does NOT use', () => {
    // Proves the semantic is genuinely timezone-sensitive: the negative case above is only
    // "not today" because of the America/New_York boundary; under UTC both are 2026-10-01.
    const request = Date.parse('2026-10-01T03:00:00Z');
    const interview = Date.parse('2026-10-01T05:00:00Z');
    expect(isoDateInTimeZone(request, 'UTC')).toBe('2026-10-01');
    expect(isoDateInTimeZone(interview, 'UTC')).toBe('2026-10-01');
  });
});
