// Pure, deterministic derivation for the My Desk read composition.
//
// No I/O and no domain access — this module is unit-testable in isolation and
// carries the logic that MUST NOT leak to the browser: urgency classified
// against the app timezone (directive §38), calendar-day aging, an explainable
// ordering comparator (directive §13), and the prototype's due-badge phrasing.
// There is NO priority-ordinal number here (R10 / directive §40).

import type { DeskPriorityItemView, DeskUrgency } from './dto/my-desk.view.js';

const DAY_MS = 86_400_000;

// The UTC anchor (00:00:00Z) of the CIVIL date that `ms` falls on in `timeZone`.
// Anchoring each civil date to UTC-midnight makes both day comparison and
// whole-day differences exact across DST and across the UTC/local split — never
// Date.getDate() on raw UTC ms (the §38 trap). en-CA formats as YYYY-MM-DD.
function civilDayUtcMs(ms: number, timeZone: string): number {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return Date.parse(`${ymd}T00:00:00Z`);
}

// YYYY-MM-DD in `timeZone` — the header date line (directive §38).
export function isoDateInTimeZone(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

// Classify a due instant relative to `now`, both resolved to civil days in the
// app timezone. A null due is 'upcoming' (a due-less item is never overdue).
export function classifyDueUrgency(
  dueAtMs: number | null,
  nowMs: number,
  timeZone: string,
): DeskUrgency {
  if (dueAtMs === null) return 'upcoming';
  const due = civilDayUtcMs(dueAtMs, timeZone);
  const today = civilDayUtcMs(nowMs, timeZone);
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  return 'upcoming';
}

// Whole calendar days elapsed between `sinceMs` and `now` in the app timezone.
// Clamped at 0 (a same-day or future instant is 0 days).
export function agingDaysInTimeZone(
  sinceMs: number,
  nowMs: number,
  timeZone: string,
): number {
  const days = Math.round(
    (civilDayUtcMs(nowMs, timeZone) - civilDayUtcMs(sinceMs, timeZone)) / DAY_MS,
  );
  return Math.max(0, days);
}

// The prototype's due badge: "2d overdue" / "Today" / "Tomorrow" / "Oct 1".
// Empty string for a null due.
export function dueBadgeLabel(
  dueAtMs: number | null,
  nowMs: number,
  timeZone: string,
): string {
  if (dueAtMs === null) return '';
  const diffDays = Math.round(
    (civilDayUtcMs(dueAtMs, timeZone) - civilDayUtcMs(nowMs, timeZone)) / DAY_MS,
  );
  if (diffDays < 0) return `${-diffDays}d overdue`;
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(dueAtMs));
}

const URGENCY_ORDER: Record<DeskUrgency, number> = {
  overdue: 0,
  today: 1,
  upcoming: 2,
};

// Deterministic, explainable order (directive §13): urgency section first, then
// earliest due within a section (a null due sorts last), then a stable id
// tie-break. No hidden ordinal — every position is reproducible from the fields.
export function comparePriorityItems(
  a: DeskPriorityItemView,
  b: DeskPriorityItemView,
): number {
  const sectionDelta = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
  if (sectionDelta !== 0) return sectionDelta;
  const da = a.due_at !== null ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
  const db = b.due_at !== null ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
