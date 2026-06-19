import { describe, expect, it } from 'vitest';

import {
  applyFilters,
  buildBoard,
  buildCalendar,
  buildGroups,
  dueBucket,
  matchesSummary,
  suggestedOrder,
  summaryCounts,
} from './workspace';
import type { TaskPriority, TaskStatus, TaskType, TaskView } from './types';

// Tasks workspace — pure-logic proofs over a VARIED fixture set (every type /
// priority / status / due-bucket represented, so every surface populates — the
// directive's "seed varied" requirement, met here as deterministic fixtures
// since the platform has no domain-data seed harness).

const NOW = new Date('2026-06-17T12:00:00Z'); // Wed; ISO week Mon 06-15 .. Sun 06-21

function t(
  id: string,
  over: Partial<TaskView> & {
    due?: string | null;
    type?: TaskType | null;
    priority?: TaskPriority | null;
    status?: TaskStatus;
  },
): TaskView {
  return {
    id,
    tenant_id: 'tn',
    title: id,
    description: null,
    due_date: over.due === undefined ? null : over.due,
    status: over.status ?? 'open',
    type: over.type ?? null,
    priority: over.priority ?? null,
    source: 'manual',
    assignee_id: 'me',
    created_by_user_id: 'me',
    owner_type: 'talent_record',
    owner_id: 'tal',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
  };
}

const FIXTURES: TaskView[] = [
  t('t1', { due: '2026-06-15T00:00:00.000Z', type: 'call', priority: 'high', status: 'open' }),
  t('t2', { due: '2026-06-17T00:00:00.000Z', type: 'email', priority: 'med', status: 'open' }),
  t('t3', { due: '2026-06-17T00:00:00.000Z', type: 'interview', priority: 'low', status: 'in_progress' }),
  t('t4', { due: '2026-06-18T00:00:00.000Z', type: 'screen', priority: 'high', status: 'open' }),
  t('t5', { due: '2026-06-20T00:00:00.000Z', type: 'follow_up', priority: 'med', status: 'open' }),
  t('t6', { due: '2026-06-30T00:00:00.000Z', type: 'consent', priority: 'low', status: 'open' }),
  t('t7', { due: null, type: 'admin', priority: null, status: 'open' }),
  t('t8', { due: '2026-06-17T00:00:00.000Z', type: 'follow_up', priority: 'med', status: 'waiting' }),
  t('t9', { due: '2026-06-16T00:00:00.000Z', type: 'call', priority: 'high', status: 'done' }),
  t('t10', { due: '2026-06-16T00:00:00.000Z', type: 'admin', priority: 'low', status: 'cancelled' }),
];

describe('dueBucket', () => {
  it('buckets by date-only relative to now', () => {
    expect(dueBucket(FIXTURES[0]!, NOW)).toBe('overdue');
    expect(dueBucket(FIXTURES[1]!, NOW)).toBe('today');
    expect(dueBucket(FIXTURES[3]!, NOW)).toBe('tomorrow');
    expect(dueBucket(FIXTURES[4]!, NOW)).toBe('week');
    expect(dueBucket(FIXTURES[5]!, NOW)).toBe('later');
    expect(dueBucket(FIXTURES[6]!, NOW)).toBe('none');
  });
});

describe('summaryCounts', () => {
  it('counts overdue/today/upcoming/waiting/done over the full set', () => {
    expect(summaryCounts(FIXTURES, NOW)).toEqual({
      overdue: 1, // t1
      today: 2, // t2, t3 (t8 is waiting, excluded)
      upcoming: 3, // t4, t5, t6
      waiting: 1, // t8
      done: 1, // t9 (t10 cancelled is not "done")
    });
  });
});

describe('buildGroups', () => {
  it('orders due buckets + Waiting; Completed only when showCompleted', () => {
    const g = buildGroups(FIXTURES, NOW, { showCompleted: false, suggested: false });
    expect(g.map((x) => x.key)).toEqual([
      'overdue',
      'today',
      'tomorrow',
      'week',
      'later',
      'none',
      'waiting',
    ]);
    const withDone = buildGroups(FIXTURES, NOW, { showCompleted: true, suggested: false });
    expect(withDone.map((x) => x.key)).toContain('completed');
    // both terminal (done + cancelled) appear in Completed
    expect(withDone.find((x) => x.key === 'completed')!.tasks).toHaveLength(2);
  });

  it('suggested re-sorts a group by due then priority', () => {
    const g = buildGroups(FIXTURES, NOW, { showCompleted: false, suggested: true });
    const today = g.find((x) => x.key === 'today')!;
    // same due → priority decides: t2 (med) before t3 (low)
    expect(today.tasks.map((x) => x.id)).toEqual(['t2', 't3']);
  });
});

describe('buildBoard', () => {
  it('groups by status into the 4 columns (cancelled excluded)', () => {
    const cols = buildBoard(FIXTURES);
    const by = Object.fromEntries(cols.map((c) => [c.key, c.tasks.map((t2) => t2.id)]));
    expect(by['open']).toEqual(['t1', 't2', 't4', 't5', 't6', 't7']);
    expect(by['in_progress']).toEqual(['t3']);
    expect(by['waiting']).toEqual(['t8']);
    expect(by['done']).toEqual(['t9']);
    // cancelled t10 appears in no column
    expect(cols.flatMap((c) => c.tasks.map((x) => x.id))).not.toContain('t10');
  });
});

describe('buildCalendar', () => {
  it('places active tasks by weekday; counts off-week + undated honestly', () => {
    const cal = buildCalendar(FIXTURES, NOW);
    const counts = cal.days.map((d) => d.tasks.length);
    // Mon(t1)=1, Tue=0, Wed(t2,t3,t8)=3, Thu(t4)=1, Fri=0, Sat(t5)=1, Sun=0
    expect(counts).toEqual([1, 0, 3, 1, 0, 1, 0]);
    expect(cal.offWeek).toBe(1); // t6 (06-30)
    expect(cal.noDate).toBe(1); // t7
    expect(cal.days[2]!.isToday).toBe(true);
  });
});

describe('suggestedOrder + matchesSummary + applyFilters', () => {
  it('suggestedOrder sorts by due (nulls last) then priority', () => {
    const ids = suggestedOrder(FIXTURES).map((x) => x.id);
    expect(ids[ids.length - 1]).toBe('t7'); // undated last
    expect(ids.indexOf('t1')).toBeLessThan(ids.indexOf('t2')); // earlier due first
  });

  it('matchesSummary partitions the cards', () => {
    expect(matchesSummary(FIXTURES[0]!, 'overdue', NOW)).toBe(true);
    expect(matchesSummary(FIXTURES[7]!, 'waiting', NOW)).toBe(true);
    expect(matchesSummary(FIXTURES[8]!, 'done', NOW)).toBe(true);
  });

  it('applyFilters: type + priority + summary; terminal hidden by default', () => {
    expect(applyFilters(FIXTURES, { type: 'call', priority: null, summary: null, showCompleted: false }, NOW).map((x) => x.id)).toEqual(['t1']);
    expect(applyFilters(FIXTURES, { type: null, priority: 'high', summary: null, showCompleted: false }, NOW).map((x) => x.id)).toEqual(['t1', 't4']);
    // default hides terminal (done/cancelled)
    const active = applyFilters(FIXTURES, { type: null, priority: null, summary: null, showCompleted: false }, NOW).map((x) => x.id);
    expect(active).not.toContain('t9');
    expect(active).not.toContain('t10');
    // summary=done surfaces the done task
    expect(applyFilters(FIXTURES, { type: null, priority: null, summary: 'done', showCompleted: false }, NOW).map((x) => x.id)).toEqual(['t9']);
  });
});
