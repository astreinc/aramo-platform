import { PRIORITY_RANK } from './task-vocab';
import type { TaskPriority, TaskStatus, TaskType, TaskView } from './types';

// Tasks workspace — pure, deterministic view-logic over the fetched task set
// (the recruiter's assignee-scoped tasks). All time-relative computation takes
// an explicit `now` so it is unit-testable. NO data fetching, NO AI: the
// "Suggested order" is a plain due→priority sort.

export type DueBucket =
  | 'overdue'
  | 'today'
  | 'tomorrow'
  | 'week'
  | 'later'
  | 'none';

export const ACTIVE_STATUSES: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'waiting',
];

export function isActive(t: TaskView): boolean {
  return t.status === 'open' || t.status === 'in_progress' || t.status === 'waiting';
}
export function isTerminal(t: TaskView): boolean {
  return t.status === 'done' || t.status === 'cancelled';
}

function dayNumber(year: number, monthIndex: number, day: number): number {
  return Math.floor(Date.UTC(year, monthIndex, day) / 86_400_000);
}

// Day-count for the date part of an ISO string (date-only; the due_date is
// stored from a 'YYYY-MM-DD' input → its first 10 chars are that calendar day).
function isoDayNumber(iso: string): number {
  const parts = iso.slice(0, 10).split('-');
  return dayNumber(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function nowDayNumber(now: Date): number {
  return dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
}

// A short, human due label for a row ("Overdue" / "Today" / a date).
export function dueShortLabel(t: TaskView, now: Date): string {
  if (t.due_date === null) return 'No date';
  switch (dueBucket(t, now)) {
    case 'overdue':
      return 'Overdue';
    case 'today':
      return 'Today';
    case 'tomorrow':
      return 'Tomorrow';
    case 'week':
    case 'later':
    default:
      return t.due_date.slice(0, 10);
  }
}

// The due-date bucket relative to `now` (date-only). Independent of status.
export function dueBucket(t: TaskView, now: Date): DueBucket {
  if (t.due_date === null) return 'none';
  const diff = isoDayNumber(t.due_date) - nowDayNumber(now);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff <= 7) return 'week';
  return 'later';
}

// ── Filters (client-side over the fetched set — mirrors the mockup; the BE
//    also supports server-side ?type/?priority/?status filtering) ──

// The summary metric a card filters to (the click-filter set).
export type SummaryKey = 'overdue' | 'today' | 'upcoming' | 'waiting' | 'done';

export interface WorkspaceFilters {
  readonly type: TaskType | null;
  readonly priority: TaskPriority | null;
  readonly summary: SummaryKey | null;
  readonly showCompleted: boolean;
}

export const EMPTY_FILTERS: WorkspaceFilters = {
  type: null,
  priority: null,
  summary: null,
  showCompleted: false,
};

// Does a task belong to a summary card's set?
export function matchesSummary(t: TaskView, key: SummaryKey, now: Date): boolean {
  switch (key) {
    case 'waiting':
      return t.status === 'waiting';
    case 'done':
      return t.status === 'done';
    case 'overdue':
      return isActive(t) && t.status !== 'waiting' && dueBucket(t, now) === 'overdue';
    case 'today':
      return isActive(t) && t.status !== 'waiting' && dueBucket(t, now) === 'today';
    case 'upcoming': {
      if (!isActive(t) || t.status === 'waiting') return false;
      const b = dueBucket(t, now);
      return b === 'tomorrow' || b === 'week' || b === 'later';
    }
  }
}

// Apply the type/priority/summary/showCompleted filters. When a summary card is
// active it is authoritative for the status/due dimension (showCompleted is
// implied by the 'done' card); otherwise terminal tasks are hidden unless
// showCompleted.
export function applyFilters(
  tasks: readonly TaskView[],
  f: WorkspaceFilters,
  now: Date,
): TaskView[] {
  return tasks.filter((t) => {
    if (f.type !== null && t.type !== f.type) return false;
    if (f.priority !== null && t.priority !== f.priority) return false;
    if (f.summary !== null) return matchesSummary(t, f.summary, now);
    if (!f.showCompleted && isTerminal(t)) return false;
    return true;
  });
}

// ── Summary counts (the metric cards) ──
export interface SummaryCounts {
  readonly overdue: number;
  readonly today: number;
  readonly upcoming: number;
  readonly waiting: number;
  readonly done: number;
}

export function summaryCounts(tasks: readonly TaskView[], now: Date): SummaryCounts {
  let overdue = 0,
    today = 0,
    upcoming = 0,
    waiting = 0,
    done = 0;
  for (const t of tasks) {
    if (t.status === 'done') {
      done += 1;
      continue;
    }
    if (t.status === 'cancelled') continue;
    if (t.status === 'waiting') {
      waiting += 1;
      continue;
    }
    const b = dueBucket(t, now);
    if (b === 'overdue') overdue += 1;
    else if (b === 'today') today += 1;
    else if (b === 'tomorrow' || b === 'week' || b === 'later') upcoming += 1;
  }
  return { overdue, today, upcoming, waiting, done };
}

// ── List grouping (ordered groups; waiting + completed are status groups,
//    the rest are due buckets over active non-waiting tasks) ──
export interface TaskGroup {
  readonly key: string;
  readonly label: string;
  readonly over: boolean; // overdue emphasis
  readonly tasks: readonly TaskView[];
}

const LIST_ORDER: ReadonlyArray<{ key: DueBucket; label: string; over: boolean }> = [
  { key: 'overdue', label: 'Overdue', over: true },
  { key: 'today', label: 'Today', over: false },
  { key: 'tomorrow', label: 'Tomorrow', over: false },
  { key: 'week', label: 'This week', over: false },
  { key: 'later', label: 'Later', over: false },
  { key: 'none', label: 'No date', over: false },
];

// Build the ordered list groups. `suggested` re-sorts each group's tasks by the
// deterministic due→priority order (the "Suggested order" toggle).
export function buildGroups(
  tasks: readonly TaskView[],
  now: Date,
  opts: { showCompleted: boolean; suggested: boolean },
): TaskGroup[] {
  const groups: TaskGroup[] = [];
  const activeNonWaiting = tasks.filter(
    (t) => isActive(t) && t.status !== 'waiting',
  );
  for (const g of LIST_ORDER) {
    let rows = activeNonWaiting.filter((t) => dueBucket(t, now) === g.key);
    if (rows.length === 0) continue;
    rows = opts.suggested ? [...rows].sort((a, b) => suggestedCompare(a, b)) : rows;
    groups.push({ key: g.key, label: g.label, over: g.over, tasks: rows });
  }
  const waiting = tasks.filter((t) => t.status === 'waiting');
  if (waiting.length > 0) {
    groups.push({ key: 'waiting', label: 'Waiting on others', over: false, tasks: waiting });
  }
  if (opts.showCompleted) {
    const completed = tasks.filter((t) => isTerminal(t));
    if (completed.length > 0) {
      groups.push({ key: 'completed', label: 'Completed', over: false, tasks: completed });
    }
  }
  return groups;
}

// Deterministic "Suggested order": due date ascending (nulls last), then
// priority (high→low), then title. NO AI — a stable, explainable sort.
export function suggestedCompare(a: TaskView, b: TaskView): number {
  const ad = a.due_date === null ? Number.POSITIVE_INFINITY : isoDayNumber(a.due_date);
  const bd = b.due_date === null ? Number.POSITIVE_INFINITY : isoDayNumber(b.due_date);
  if (ad !== bd) return ad - bd;
  const ap = a.priority === null ? 3 : PRIORITY_RANK[a.priority];
  const bp = b.priority === null ? 3 : PRIORITY_RANK[b.priority];
  if (ap !== bp) return ap - bp;
  return a.title.localeCompare(b.title);
}

export function suggestedOrder(tasks: readonly TaskView[]): TaskView[] {
  return [...tasks].sort((a, b) => suggestedCompare(a, b));
}

// ── Board (by status) — the active columns + a Done drop target (mockup
//    parity). `cancelled` is excluded from the board. ──
export interface BoardColumn {
  readonly key: TaskStatus;
  readonly label: string;
  readonly tasks: readonly TaskView[];
}

export const BOARD_COLUMN_KEYS: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'waiting',
  'done',
];

export function buildBoard(tasks: readonly TaskView[]): BoardColumn[] {
  return BOARD_COLUMN_KEYS.map((key) => ({
    key,
    label: key,
    tasks: tasks.filter((t) => t.status === key),
  }));
}

// ── Calendar (current week, Mon–Sun) — tasks placed by due_date; off-week
//    tasks are counted, not faked onto a day. ──
export interface CalendarDay {
  readonly weekday: string;
  readonly dayOfMonth: number;
  readonly isToday: boolean;
  readonly tasks: readonly TaskView[];
}
export interface CalendarWeek {
  readonly days: readonly CalendarDay[];
  readonly offWeek: number; // active tasks with a due date outside this week
  readonly noDate: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function buildCalendar(tasks: readonly TaskView[], now: Date): CalendarWeek {
  const todayNum = nowDayNumber(now);
  // Monday-based index for `now` (JS getDay: 0=Sun..6=Sat → 0=Mon..6=Sun).
  const todayIdx = (now.getDay() + 6) % 7;
  const weekStart = todayNum - todayIdx; // day-number of Monday
  const buckets: TaskView[][] = WEEKDAYS.map(() => []);
  let offWeek = 0;
  let noDate = 0;
  for (const t of tasks) {
    if (isTerminal(t)) continue;
    if (t.due_date === null) {
      noDate += 1;
      continue;
    }
    const idx = isoDayNumber(t.due_date) - weekStart;
    if (idx >= 0 && idx < 7) buckets[idx]!.push(t);
    else offWeek += 1;
  }
  const days = WEEKDAYS.map((weekday, i) => {
    const dayNum = weekStart + i;
    const date = new Date((dayNum * 86_400_000) + 12 * 3_600_000); // noon UTC, stable
    return {
      weekday,
      dayOfMonth: date.getUTCDate(),
      isToday: dayNum === todayNum,
      tasks: buckets[i]!.slice().sort((a, b) => suggestedCompare(a, b)),
    };
  });
  return { days, offWeek, noDate };
}
