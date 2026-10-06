// Pure, deterministic derivation for the My Desk read composition.
//
// No I/O and no domain access — this module is unit-testable in isolation and
// carries the My-Desk-specific presentation logic: urgency classified against the
// app timezone (directive §38), an explainable ordering comparator (directive
// §13), and the prototype's due-badge phrasing. There is NO priority-ordinal
// number here (R10 / directive §40). The timezone civil-day math itself is the
// canonical @aramo/common primitive — this module derives from it, never
// re-implements it.

import { civilDayUtcMs } from '@aramo/common';

import type {
  DeskItemKind,
  DeskPriorityItemView,
  DeskUrgency,
} from './dto/my-desk.view.js';

const DAY_MS = 86_400_000;

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

// Presentation precedence WITHIN an urgency section (Architect ruling): the
// domain-derived actionable work is ordered ahead of generic follow-ups/tasks,
// most-actionable first. Explicit + deterministic — no hidden ordinal.
const KIND_PRECEDENCE: Record<DeskItemKind, number> = {
  submittal: 0,
  rtr: 1,
  engagement: 2,
  client: 3,
  follow_up: 3,
  task: 4,
};

// Deterministic, explainable order (directive §13, §9): urgency section first,
// then the kind precedence, then earliest due within a section (a null due
// sorts last), then a stable id tie-break. No hidden ordinal — every position
// is reproducible from the fields.
export function comparePriorityItems(
  a: DeskPriorityItemView,
  b: DeskPriorityItemView,
): number {
  const sectionDelta = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
  if (sectionDelta !== 0) return sectionDelta;
  const kindDelta = KIND_PRECEDENCE[a.kind] - KIND_PRECEDENCE[b.kind];
  if (kindDelta !== 0) return kindDelta;
  const da = a.due_at !== null ? Date.parse(a.due_at) : Number.POSITIVE_INFINITY;
  const db = b.due_at !== null ? Date.parse(b.due_at) : Number.POSITIVE_INFINITY;
  if (da !== db) return da - db;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}
