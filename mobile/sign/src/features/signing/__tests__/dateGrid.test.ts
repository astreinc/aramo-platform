// FIELD-PARITY-1 P3 T-3 — the DATE picker's month grid (calendar dates only).
import { canShift, daysInMonth, inBounds, isoOf, monthGrid, shiftMonth, startMonth } from '../dateGrid';

describe('dateGrid', () => {
  it('builds Sunday-first weeks padded with null', () => {
    const weeks = monthGrid({ year: 2026, month: 1 }); // February 2026 starts on a Sunday
    expect(weeks[0]?.[0]).toBe('2026-02-01');
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(28);
    const march = monthGrid({ year: 2026, month: 2 }); // March 2026 starts on a Sunday too
    expect(march.every((w) => w.length === 7)).toBe(true);
    const nov = monthGrid({ year: 2026, month: 10 }); // November 2026 starts on a Sunday
    expect(nov[0]?.[0]).toBe('2026-11-01');
    const oct = monthGrid({ year: 2026, month: 9 }); // October 2026 starts on a Thursday
    expect(oct[0]?.slice(0, 4)).toEqual([null, null, null, null]);
    expect(oct[0]?.[4]).toBe('2026-10-01');
  });

  it('month arithmetic and leap years', () => {
    expect(daysInMonth({ year: 2028, month: 1 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 1 })).toBe(28);
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(isoOf(2026, 2, 4)).toBe('2026-03-04');
  });

  it('honours the date_range bounds', () => {
    expect(inBounds('2026-01-01', '2026-01-01', '2026-12-31')).toBe(true);
    expect(inBounds('2025-12-31', '2026-01-01', null)).toBe(false);
    expect(inBounds('2027-01-01', null, '2026-12-31')).toBe(false);
    expect(canShift({ year: 2026, month: 0 }, -1, '2026-01-15', null)).toBe(false);
    expect(canShift({ year: 2026, month: 0 }, 1, '2026-01-15', '2026-02-01')).toBe(true);
    expect(canShift({ year: 2026, month: 1 }, 1, null, '2026-02-01')).toBe(false);
  });

  it('opens on the value, else today inside the bounds', () => {
    const today = new Date(2026, 9, 24);
    expect(startMonth('2027-05-09', null, null, today)).toEqual({ year: 2027, month: 4 });
    expect(startMonth(null, null, null, today)).toEqual({ year: 2026, month: 9 });
    expect(startMonth(null, '2027-01-10', null, today)).toEqual({ year: 2027, month: 0 });
    expect(startMonth(null, null, '2026-03-01', today)).toEqual({ year: 2026, month: 2 });
  });
});
