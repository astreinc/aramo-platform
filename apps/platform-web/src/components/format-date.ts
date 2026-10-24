// PLATFORM-UX-1 F-1 — the console date grammar (handoff §3.6 "Dates"):
//   absolute + relative: "2 Oct 2026 · 22 days ago"
//   timestamps (mono):   "2026-10-02 22:13 UTC"
// All values are rendered in UTC so every operator sees the same instant.
// Mirrors the design file's fmtD / rel / ts helpers (Platform Admin.dc.html).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const DAY_MS = 86_400_000;

type DateInput = string | Date | null | undefined;

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2 Oct 2026" (UTC). An empty or invalid value renders "—". */
export function formatDate(value: DateInput): string {
  const d = toDate(value);
  if (d === null) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Whole days between `value` and `now` (positive = in the past). */
export function daysAgo(value: DateInput, now: Date = new Date()): number | null {
  const d = toDate(value);
  if (d === null) return null;
  return Math.floor((now.getTime() - d.getTime()) / DAY_MS);
}

/**
 * "today" · "1 day ago" · "22 days ago" · "3 months ago" (from 60 days) ·
 * "in 1 day" · "in 5 days". An empty or invalid value renders "".
 */
export function formatRelative(value: DateInput, now: Date = new Date()): string {
  const n = daysAgo(value, now);
  if (n === null) return '';
  if (n < 0) return `in ${-n} ${n === -1 ? 'day' : 'days'}`;
  if (n === 0) return 'today';
  if (n === 1) return '1 day ago';
  if (n < 60) return `${n} days ago`;
  return `${Math.round(n / 30.4)} months ago`;
}

/** "2 Oct 2026 · 22 days ago". An empty or invalid value renders "—". */
export function formatDateRelative(value: DateInput, now: Date = new Date()): string {
  const d = toDate(value);
  if (d === null) return '—';
  return `${formatDate(d)} · ${formatRelative(d, now)}`;
}

/** "2026-10-02 22:13 UTC" — render in the mono face. Empty or invalid → "". */
export function formatTimestamp(value: DateInput): string {
  const d = toDate(value);
  if (d === null) return '';
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "22:13 UTC" — the dashboard "Refreshed" clock. Empty or invalid → "". */
export function formatClock(value: DateInput): string {
  const d = toDate(value);
  if (d === null) return '';
  return `${d.toISOString().slice(11, 16)} UTC`;
}
