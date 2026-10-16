import { Button } from '@aramo/fe-foundation';

import { PRIORITY_LABELS, TYPE_LABELS } from './task-vocab';
import type { TaskView } from './types';

// Tasks FE — presentational task list for the per-entity TasksPanel (the /tasks
// workspace has its own rich row). Per-row controls render ONLY when canWrite
// (task:write) — a read-only actor sees tasks, no controls (Ruling 4). Shows
// the workspace fields (type label + priority dot) when present.

interface TaskListProps {
  readonly items: readonly TaskView[];
  readonly canWrite: boolean;
  readonly onToggleStatus: (task: TaskView) => void;
  readonly onEdit: (task: TaskView) => void;
  readonly onDelete: (task: TaskView) => void;
  readonly emptyMessage: string;
}

function dueLabel(due: string | null): string {
  if (due === null) return 'No due date';
  return `Due ${due.slice(0, 10)}`;
}

export function TaskList({
  items,
  canWrite,
  onToggleStatus,
  onEdit,
  onDelete,
  emptyMessage,
}: TaskListProps) {
  if (items.length === 0) {
    return <p className="task-list__empty">{emptyMessage}</p>;
  }
  return (
    <ul className="task-list">
      {items.map((t) => (
        <li key={t.id} className="task-list__row" data-testid="task-row">
          <span className={`task-list__status task-list__status--${t.status}`}>
            {t.status === 'done' || t.status === 'cancelled' ? '✓' : '○'}
          </span>
          {t.priority !== null ? (
            <span
              className={`rc-pdot rc-pdot--${t.priority}`}
              title={`Priority: ${PRIORITY_LABELS[t.priority]}`}
              aria-label={`Priority ${PRIORITY_LABELS[t.priority]}`}
            />
          ) : null}
          <span className="task-list__title">{t.title}</span>
          {t.type !== null ? (
            <span className="task-list__type"> · {TYPE_LABELS[t.type]}</span>
          ) : null}
          <span className="task-list__due"> · {dueLabel(t.due_date)}</span>
          {t.assignee_id !== null ? (
            <span className="task-list__assignee"> · assigned</span>
          ) : (
            <span className="task-list__assignee"> · unassigned</span>
          )}
          {canWrite ? (
            <span className="task-list__controls">
              {' · '}
              <Button
                type="button"
                onClick={() => onToggleStatus(t)}
                data-testid="task-toggle"
              >
                {t.status === 'done' ? 'Reopen' : 'Mark done'}
              </Button>
              {' · '}
              <Button type="button" onClick={() => onEdit(t)} data-testid="task-edit">
                Edit
              </Button>
              {' · '}
              <Button type="button" onClick={() => onDelete(t)} data-testid="task-delete">
                Delete
              </Button>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

// Compact card rows for the Requisition Detail Tasks card (prototype: checkbox ·
// bold title — assignee · due chip · Open →). Controls render ONLY when canWrite.
function dueChip(due: string | null, done: boolean): { text: string; tone: string } | null {
  if (due === null || done) return null;
  const d = due.slice(0, 10);
  const today = new Date();
  const iso = (x: Date): string =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d < iso(today)) return { text: 'overdue', tone: 'late' };
  if (d === iso(today)) return { text: 'due today', tone: 'late' };
  if (d === iso(tomorrow)) return { text: 'due tomorrow', tone: 'soon' };
  const [y, m, day] = d.split('-').map(Number);
  const label = new Date(y ?? 0, (m ?? 1) - 1, day ?? 1).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return { text: `due ${label}`, tone: 'later' };
}

export function TaskCardRows({
  items,
  canWrite,
  assigneeNames,
  onToggleStatus,
  onEdit,
  onDelete,
  emptyMessage,
}: TaskListProps & { readonly assigneeNames: Readonly<Record<string, string>> }) {
  if (items.length === 0) {
    return <p className="rc-tl__empty task-list__empty">{emptyMessage}</p>;
  }
  return (
    <div>
      {items.map((t) => {
        const done = t.status === 'done' || t.status === 'cancelled';
        const due = dueChip(t.due_date, done);
        const assignee = t.assignee_id !== null ? (assigneeNames[t.assignee_id] ?? null) : null;
        const meta = [
          t.type !== null ? TYPE_LABELS[t.type] : null,
          t.assignee_id === null ? 'unassigned' : assignee !== null ? `assigned to ${assignee}` : 'assigned',
        ].filter((x): x is string => x !== null);
        return (
          <div key={t.id} className={`rc-tk__row${done ? ' rc-tk__row--done' : ''}`} data-testid="task-row">
            {canWrite ? (
              <Button
                unstyled
                type="button"
                className={`rc-tk__check${done ? ' rc-tk__check--on' : ''}`}
                onClick={() => onToggleStatus(t)}
                aria-label={done ? `Reopen ${t.title}` : `Mark ${t.title} done`}
                data-testid="task-toggle"
              >
                {done ? '✓' : ''}
              </Button>
            ) : (
              <span className={`rc-tk__check${done ? ' rc-tk__check--on' : ''}`} aria-hidden="true">
                {done ? '✓' : ''}
              </span>
            )}
            <span className="rc-tk__body">
              {t.priority !== null ? (
                <span
                  className={`rc-pdot rc-pdot--${t.priority}`}
                  title={`Priority: ${PRIORITY_LABELS[t.priority]}`}
                  aria-label={`Priority ${PRIORITY_LABELS[t.priority]}`}
                />
              ) : null}
              <b>{t.title}</b>
              <span className="rc-tk__meta"> — {meta.join(' · ')}</span>
            </span>
            {due !== null ? <span className={`rc-tk__due rc-tk__due--${due.tone}`}>{due.text}</span> : null}
            {canWrite ? (
              <>
                <Button unstyled type="button" className="rc-link rc-tk__open" onClick={() => onEdit(t)} data-testid="task-edit">
                  Open →
                </Button>
                <Button unstyled type="button" className="rc-tk__del" onClick={() => onDelete(t)} data-testid="task-delete">
                  Delete
                </Button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
