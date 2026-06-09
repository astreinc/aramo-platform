import { useEffect, useState } from 'react';
import {
  InlineAlert,
  PageHeader,
  hasScope,
  useSession,
  type Session,
} from '@aramo/fe-foundation';

import {
  deleteTask,
  listMyTasks,
  probeTenantUsers,
  updateTask,
  type RosterState,
} from './task-api';
import { taskListErrorMessage, taskMutateErrorMessage } from './error-messages';
import { TaskDialog } from './TaskDialog';
import { TaskList } from './TaskList';
import type { TaskStatus, TaskView } from './types';

// Tasks FE — the /tasks "my tasks / upcoming" route (Ruling 1). Lists the
// actor's tasks (GET /v1/tasks?assignee_id=me), backend due-sorted, default
// status open. Per-row mutations (status-toggle / edit-reassign / delete) are
// gated task:write. Creating a task happens from a per-entity Tasks tab (the
// owner is the in-context entity); a /tasks owner-picker create is a filed
// carry — so this route has no "new task" button.

interface MyTasksViewProps {
  readonly sessionOverride?: Session;
}

const EMPTY_ROSTER: RosterState = { available: false, items: [] };

export function MyTasksView({ sessionOverride }: MyTasksViewProps) {
  const sessionState = useSession();
  const session: Session | null =
    sessionOverride ??
    (sessionState.status === 'authenticated' ? sessionState.session : null);
  const canWrite =
    session !== null && Array.isArray(session.scopes) && hasScope(session, 'task:write');

  const [items, setItems] = useState<readonly TaskView[]>([]);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('open');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterState>(EMPTY_ROSTER);
  const [editing, setEditing] = useState<TaskView | null>(null);

  function reload(filter: TaskStatus | 'all'): void {
    setLoading(true);
    setError(null);
    listMyTasks(filter)
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
    listMyTasks(statusFilter)
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
  }, [statusFilter, canWrite]);

  async function toggle(task: TaskView): Promise<void> {
    try {
      await updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' });
      reload(statusFilter);
    } catch (err) {
      setError(taskMutateErrorMessage(err));
    }
  }

  async function remove(task: TaskView): Promise<void> {
    try {
      await deleteTask(task.id);
      reload(statusFilter);
    } catch (err) {
      setError(taskMutateErrorMessage(err));
    }
  }

  return (
    <section>
      <PageHeader
        title="My tasks"
        description="Your open follow-ups, soonest due first. Create tasks from a talent, requisition, or company."
      />
      <p className="my-tasks__filter">
        <label>
          Show{' '}
          <select
            aria-label="Status filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as TaskStatus | 'all')}
          >
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>
        </label>
      </p>
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {loading ? (
        <p>Loading tasks…</p>
      ) : (
        <TaskList
          items={items}
          canWrite={canWrite}
          onToggleStatus={(t) => void toggle(t)}
          onEdit={(t) => setEditing(t)}
          onDelete={(t) => void remove(t)}
          emptyMessage="You have no tasks here."
        />
      )}
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
            reload(statusFilter);
          }}
        />
      ) : null}
    </section>
  );
}
