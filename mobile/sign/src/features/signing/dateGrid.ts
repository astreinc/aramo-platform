// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §6 T-3 — the
// month grid behind the DATE field's picker. Pure and dependency-free (the app ships no native
// date picker): calendar dates only, as YYYY-MM-DD, never a time or a time zone.

export interface YearMonth {
  readonly year: number;
  /** 0 = January. */
  readonly month: number;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function isoOf(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`;
}

export function daysInMonth(ym: YearMonth): number {
  return new Date(Date.UTC(ym.year, ym.month + 1, 0)).getUTCDate();
}

export function shiftMonth(ym: YearMonth, delta: number): YearMonth {
  const m = ym.year * 12 + ym.month + delta;
  return { year: Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
}

function monthOfIso(iso: string): YearMonth {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 };
}

const key = (ym: YearMonth) => ym.year * 12 + ym.month;

/** Weeks (Sunday first) of the month; null pads the days outside it. */
export function monthGrid(ym: YearMonth): (string | null)[][] {
  const first = new Date(Date.UTC(ym.year, ym.month, 1)).getUTCDay();
  const cells: (string | null)[] = Array.from({ length: first }, () => null);
  for (let d = 1; d <= daysInMonth(ym); d += 1) cells.push(isoOf(ym.year, ym.month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** A date the field accepts (inside its date_range bounds, when it has them). */
export function inBounds(iso: string, min: string | null, max: string | null): boolean {
  return (min === null || iso >= min) && (max === null || iso <= max);
}

/** The month the picker opens on: the value's, else today's, moved inside the bounds. */
export function startMonth(value: string | null, min: string | null, max: string | null, today: Date): YearMonth {
  if (value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value)) return monthOfIso(value);
  const now = isoOf(today.getFullYear(), today.getMonth(), today.getDate());
  if (min !== null && now < min) return monthOfIso(min);
  if (max !== null && now > max) return monthOfIso(max);
  return monthOfIso(now);
}

/** Whether the picker may move by `delta` months without leaving the bounds entirely. */
export function canShift(ym: YearMonth, delta: number, min: string | null, max: string | null): boolean {
  const next = key(shiftMonth(ym, delta));
  if (min !== null && next < key(monthOfIso(min))) return false;
  if (max !== null && next > key(monthOfIso(max))) return false;
  return true;
}

export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
export const WEEKDAY_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
