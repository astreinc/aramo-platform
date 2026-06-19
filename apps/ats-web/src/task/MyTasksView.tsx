import { useEffect, useMemo, useState } from 'react';
import {
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import { ReservedSeam } from '../ui';

import { listMyTasks, probeTenantUsers, updateTask, type RosterState } from './task-api';
import { taskListErrorMessage, taskMutateErrorMessage } from './error-messages';
import { TaskDialog } from './TaskDialog';
import {
  applyFilters,
  buildGroups,
  summaryCounts,
  type SummaryKey,
} from './workspace';
import { TaskSummaryCards } from './components/TaskSummaryCards';
import { TaskToolbar, type TaskViewMode } from './components/TaskToolbar';
import { QuickAddSeam } from './components/QuickAddSeam';
import { TaskListGroups } from './components/TaskListGroups';
import { TaskBoard } from './components/TaskBoard';
import { TaskCalendar } from './components/TaskCalendar';
import { TaskBulkBar } from './components/TaskBulkBar';
import { TaskDrawer } from './components/TaskDrawer';
import type { TaskPriority, TaskStatus, TaskType, TaskView } from './types';

// Tasks workspace — the /tasks page, rebuilt to the enterprise mockup (the
// Add-Talent-parity precedent). Recruiter view = assignee-scoped (assignee =
// the principal, server-side — NOT a persona toggle). List / Board / Calendar
// over one backed data set; summary click-filters + Type/Priority filters;
// bulk Complete / Reschedule / Snooze (backed); per-row snooze/reschedule/done;
// a detail drawer; a deterministic due→priority "Suggested order" (no AI). The
// quick-add bar and auto-generation are RESERVED seams (un-backed → not faked).
// Lead/manager pod oversight is DEFERRED (no team tier) — see
// go-live-known-limitations.md.

interface MyTasksViewProps {
  readonly sessionOverride?: Session;
  readonly nowOverride?: Date;
}

const EMPTY_ROSTER: RosterState = { available: false, items: [] };

// Shift a date (the date part of an ISO string, or `now` when null) by N days,
// returning a 'YYYY-MM-DD' the BE parses back to a Date.
function shiftDate(fromIso: string | null, days: number, now: Date): string {
  let y: number, m: number, d: number;
  if (fromIso !== null) {
    [y, m, d] = fromIso.slice(0, 10).split('-').map(Number) as [number, number, number];
  } else {
    y = now.getFullYear();
    m = now.getMonth() + 1;
    d = now.getDate();
  }
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

export function MyTasksView({ sessionOverride, nowOverride }: MyTasksViewProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canWrite =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'task:write');

  const now = useMemo(() => nowOverride ?? new Date(), [nowOverride]);

  const [items, setItems] = useState<readonly TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterState>(EMPTY_ROSTER);

  const [view, setView] = useState<TaskViewMode>('list');
  const [typeFilter, setTypeFilter] = useState<TaskType | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | null>(null);
  const [summary, setSummary] = useState<SummaryKey | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [suggested, setSuggested] = useState(false);

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawer, setDrawer] = useState<TaskView | null>(null);
  const [editing, setEditing] = useState<TaskView | null>(null);
  const [busy, setBusy] = useState(false);

  function reload(): void {
    listMyTasks('all')
      .then((res) => {
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        setError(taskListErrorMessage(err));
        setLoading(false);
      });
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMyTasks('all')
      .then((res) => {
        if (!cancelled) {
          setItems(res.items);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(taskListErrorMessage(err));
          setLoading(false);
        }
      });
    if (canWrite) {
      probeTenantUsers()
        .then((r) => {
          if (!cancelled) setRoster(r);
        })
        .catch(() => {
          if (!cancelled) setRoster(EMPTY_ROSTER);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [canWrite]);

  const counts = useMemo(() => summaryCounts(items, now), [items, now]);

  const listFiltered = useMemo(
    () =>
      applyFilters(
        items,
        { type: typeFilter, priority: priorityFilter, summary, showCompleted: showCompleted || summary === 'done' },
        now,
      ),
    [items, typeFilter, priorityFilter, summary, showCompleted, now],
  );
  // Board + Calendar keep terminal/done in scope (the Done column / undated
  // counts) — only the active list hides completed behind the toggle.
  const viewFiltered = useMemo(
    () =>
      applyFilters(
        items,
        { type: typeFilter, priority: priorityFilter, summary, showCompleted: true },
        now,
      ),
    [items, typeFilter, priorityFilter, summary, now],
  );
  const groups = useMemo(
    () => buildGroups(listFiltered, now, { showCompleted: showCompleted || summary === 'done', suggested }),
    [listFiltered, now, showCompleted, summary, suggested],
  );

  async function mutate(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await fn();
      reload();
    } catch (err) {
      setError(taskMutateErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleDone(task: TaskView): void {
    const next: TaskStatus = task.status === 'done' ? 'open' : 'done';
    void mutate(() => updateTask(task.id, { status: next }));
  }
  function snooze(task: TaskView): void {
    void mutate(() => updateTask(task.id, { due_date: shiftDate(task.due_date, 1, now) }));
  }
  function reschedule(task: TaskView): void {
    void mutate(() => updateTask(task.id, { due_date: shiftDate(null, 1, now) }));
  }
  function move(task: TaskView, status: TaskStatus): void {
    void mutate(() => updateTask(task.id, { status }));
  }

  function selectedTasks(): TaskView[] {
    return items.filter((t) => selected.has(t.id));
  }
  function bulk(apply: (t: TaskView) => Promise<unknown>): void {
    const targets = selectedTasks();
    if (targets.length === 0) return;
    void mutate(async () => {
      await Promise.all(targets.map((t) => apply(t)));
      setSelected(new Set());
    });
  }
  const bulkComplete = () => bulk((t) => updateTask(t.id, { status: 'done' }));
  const bulkReschedule = () => bulk((t) => updateTask(t.id, { due_date: shiftDate(null, 1, now) }));
  const bulkSnooze = () => bulk((t) => updateTask(t.id, { due_date: shiftDate(t.due_date, 1, now) }));

  function toggleSelect(task: TaskView): void {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(task.id)) next.delete(task.id);
      else next.add(task.id);
      return next;
    });
  }

  function selectSummary(key: SummaryKey): void {
    setSummary((cur) => (cur === key ? null : key));
  }

  return (
    <section className="rc-tasks">
      <PageHeader
        title="Tasks"
        description="Everything that needs you — calls, follow-ups, interviews, consent."
      />

      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}

      <TaskSummaryCards counts={counts} activeKey={summary} onSelect={selectSummary} />

      <TaskToolbar
        view={view}
        onView={setView}
        typeFilter={typeFilter}
        onTypeFilter={setTypeFilter}
        priorityFilter={priorityFilter}
        onPriorityFilter={setPriorityFilter}
        showCompleted={showCompleted}
        onShowCompleted={setShowCompleted}
        suggested={suggested}
        onSuggested={setSuggested}
      />

      <QuickAddSeam />

      {loading ? (
        <p className="rc-muted-line">Loading tasks…</p>
      ) : view === 'list' ? (
        <TaskListGroups
          groups={groups}
          now={now}
          canWrite={canWrite}
          selected={selected}
          onToggleSelect={toggleSelect}
          onToggleDone={toggleDone}
          onSnooze={snooze}
          onReschedule={reschedule}
          onOpen={setDrawer}
        />
      ) : view === 'board' ? (
        <TaskBoard tasks={viewFiltered} now={now} canWrite={canWrite} onMove={move} onOpen={setDrawer} />
      ) : (
        <TaskCalendar tasks={viewFiltered} now={now} onOpen={setDrawer} />
      )}

      <ReservedSeam title="Auto-generated tasks" tag="Coming with Aramo Core">
        Tasks raised automatically from Aramo workflow events (e.g. a stalled
        submittal) arrive with Aramo Core. Today every task is created by you.
      </ReservedSeam>

      <TaskBulkBar
        count={selected.size}
        busy={busy}
        onComplete={bulkComplete}
        onReschedule={bulkReschedule}
        onSnooze={bulkSnooze}
        onClear={() => setSelected(new Set())}
      />

      <TaskDrawer
        task={drawer}
        now={now}
        canWrite={canWrite}
        onClose={() => setDrawer(null)}
        onToggleDone={(t) => {
          toggleDone(t);
          setDrawer(null);
        }}
        onReschedule={(t) => {
          reschedule(t);
          setDrawer(null);
        }}
        onEdit={(t) => {
          setDrawer(null);
          setEditing(t);
        }}
      />

      {editing !== null ? (
        <TaskDialog
          open
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          mode="edit"
          initial={editing}
          roster={roster}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      ) : null}
    </section>
  );
}
