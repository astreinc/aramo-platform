import { describe, expect, it } from 'vitest';

import { formatDate } from './date';

// D2 — the shared formatter that replaced raw-ISO rendering at the activity
// timeline (#7) and the cockpit start_date edit field (#14).
describe('formatDate', () => {
  it('reduces a full ISO datetime to its UTC calendar date (YYYY-MM-DD)', () => {
    expect(formatDate('2026-08-01T14:22:31.000Z')).toBe('2026-08-01');
  });

  it('passes a date-only string through unchanged (already YYYY-MM-DD)', () => {
    expect(formatDate('2026-08-01')).toBe('2026-08-01');
  });

  it('produces a value an <input type="date"> accepts (no time, no offset)', () => {
    const out = formatDate('2026-12-09T09:05:00+05:30');
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 09:05 at +05:30 is 03:35Z — still the 9th in UTC.
    expect(out).toBe('2026-12-09');
  });

  it('is timezone-stable: an instant late in a UTC day stays that UTC day', () => {
    expect(formatDate('2026-03-15T23:59:59.999Z')).toBe('2026-03-15');
  });

  it('returns empty string for empty, null, or undefined', () => {
    expect(formatDate('')).toBe('');
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
  });

  it('returns an unparseable input unchanged (never silently blanks real data)', () => {
    expect(formatDate('not-a-date')).toBe('not-a-date');
  });
});
