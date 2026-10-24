import { describe, expect, it } from 'vitest';

import { daysAgo, formatClock, formatDate, formatDateRelative, formatRelative, formatTimestamp } from './format-date';

const NOW = new Date('2026-10-24T15:00:00Z');

describe('format-date (handoff §3.6 Dates)', () => {
  it('formats the absolute date in UTC', () => {
    expect(formatDate('2026-10-02T22:13:00Z')).toBe('2 Oct 2026');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  it('formats the relative age', () => {
    expect(formatRelative('2026-10-02T09:00:00Z', NOW)).toBe('22 days ago');
    expect(formatRelative('2026-10-24T09:00:00Z', NOW)).toBe('today');
    expect(formatRelative('2026-10-23T09:00:00Z', NOW)).toBe('1 day ago');
    expect(formatRelative('2026-10-29T15:00:00Z', NOW)).toBe('in 5 days');
    expect(formatRelative('2026-10-25T15:00:00Z', NOW)).toBe('in 1 day');
    expect(formatRelative('2026-03-02T09:00:00Z', NOW)).toBe('8 months ago');
    expect(daysAgo('2026-10-02T09:00:00Z', NOW)).toBe(22);
  });

  it('joins absolute and relative with a middle dot', () => {
    expect(formatDateRelative('2026-10-02T09:00:00Z', NOW)).toBe('2 Oct 2026 · 22 days ago');
    expect(formatDateRelative(undefined, NOW)).toBe('—');
  });

  it('formats mono timestamps and the clock', () => {
    expect(formatTimestamp('2026-10-02T22:13:45Z')).toBe('2026-10-02 22:13 UTC');
    expect(formatTimestamp(null)).toBe('');
    expect(formatClock('2026-10-24T15:00:00Z')).toBe('15:00 UTC');
  });
});
