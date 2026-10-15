import { useEffect, useState } from 'react';
import { Button, InlineAlert } from '@aramo/fe-foundation';

import { fetchAssignableUsers, type AssignableUser } from '../users/users-api';

import {
  deleteTask,
  listTasksForOwner,
  updateTask,
} from './task-api';
import { taskListErrorMessage, taskMutateErrorMessage } from './error-messages';
import { TaskDialog } from './TaskDialog';
import { TaskCardRows, TaskList } from './TaskList';
import type { TaskOwnerType, TaskView } from './types';

// Tasks FE — the per-entity Tasks tab panel (Ruling 2). Lists the in-context
// entity's tasks (GET /v1/tasks?owner_type&owner_id) and hosts create/edit/
// status-toggle/delete (gated task:write via canWrite). Cloned from the R7
// SelectionsPanel shape (a self-fetching tab panel keyed to an entity id).

interface TasksPanelProps {
  readonly ownerType: TaskOwnerType;
  readonly ownerId: string;
  readonly canWrite: boolean;
  // Opt-in card layout (Requisition Detail prototype): the title, "+ New task"
  // and the footnote sit INSIDE one card with compact rows. Without a title the
  // panel keeps its original list layout (other entity pages are unchanged).
  readonly cardTitle?: string;
  readonly cardFootnote?: string;
}

const EMPTY_ROSTER: readonly AssignableUser[] = [];

export function TasksPanel({
  ownerType,
  ownerId,
  canWrite,
  cardTitle,
  cardFootnote,
}: TasksPanelProps) {
  const [items, setItems] = useState<readonly TaskView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roster, setRoster] = useState<readonly AssignableUser[]>(EMPTY_ROSTER);
  const [dialog, setDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; task: TaskView } | null
  >(null);

  function reload(): void {
    setLoading(true);
    setError(null);
    listTasksForOwner(ownerType, ownerId, 'all')
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
    listTasksForOwner(ownerType, ownerId, 'all')
      .then((res) => {
        if (cancelled) return;
        setItems(res.items);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(taskListErrorMessage(err));
        setLoading(false);
      });
    // Probe the roster once (for the assignee Combobox); only needed when the
    // actor can write. Graceful 403 → no picker (handled in the dialog).
    if (canWrite) {
      fetchAssignableUsers()
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
  }, [ownerType, ownerId, canWrite]);

  async function toggle(task: TaskView): Promise<void> {
    try {
      await updateTask(task.id, { status: task.status === 'done' ? 'open' : 'done' });
      reload();
    } catch (err) {
      setError(taskMutateErrorMessage(err));
    }
  }

  async function remove(task: TaskView): Promise<void> {
    try {
      await deleteTask(task.id);
      reload();
    } catch (err) {
      setError(taskMutateErrorMessage(err));
    }
  }

  const dialogEl =
    dialog !== null ? (
      <TaskDialog
        open
        onOpenChange={(o) => {
          if (!o) setDialog(null);
        }}
        mode={dialog.mode}
        ownerType={ownerType}
        ownerId={ownerId}
        initial={dialog.mode === 'edit' ? dialog.task : undefined}
        roster={roster}
        onSaved={() => {
          setDialog(null);
          reload();
        }}
      />
    ) : null;

  if (cardTitle !== undefined) {
    const names = Object.fromEntries(
      roster.flatMap((u) => (u.display_name !== null ? [[u.user_id, u.display_name] as const] : [])),
    );
    return (
      <div className="rc-card rc-tl tasks-panel">
        <div className="rc-tl__head">
          <h2>{cardTitle}</h2>
          {canWrite ? (
            <div className="rc-tl__actions">
              <Button
                unstyled
                type="button"
                className="rc-link"
                onClick={() => setDialog({ mode: 'create' })}
                data-testid="task-new"
              >
                + New task
              </Button>
            </div>
          ) : null}
        </div>
        {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
        {loading ? (
          <p className="rc-tl__empty">Loading tasks…</p>
        ) : (
          <TaskCardRows
            items={items}
            canWrite={canWrite}
            assigneeNames={names}
            onToggleStatus={(t) => void toggle(t)}
            onEdit={(t) => setDialog({ mode: 'edit', task: t })}
            onDelete={(t) => void remove(t)}
            emptyMessage="No tasks on this requisition yet."
          />
        )}
        {cardFootnote !== undefined ? <p className="rc-tl__foot">{cardFootnote}</p> : null}
        {dialogEl}
      </div>
    );
  }

  if (loading) return <p>Loading tasks…</p>;

  return (
    <div className="tasks-panel">
      {error !== null ? <InlineAlert variant="error">{error}</InlineAlert> : null}
      {canWrite ? (
        <p className="tasks-panel__toolbar">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDialog({ mode: 'create' })}
            data-testid="task-new"
          >
            New task
          </Button>
        </p>
      ) : null}
      <TaskList
        items={items}
        canWrite={canWrite}
        onToggleStatus={(t) => void toggle(t)}
        onEdit={(t) => setDialog({ mode: 'edit', task: t })}
        onDelete={(t) => void remove(t)}
        emptyMessage="No tasks for this record yet."
      />
      {dialogEl}
    </div>
  );
}
