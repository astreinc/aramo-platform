import type { TaskView } from './types';

// Tasks FE — presentational task list (shared by the per-entity TasksPanel
// and the /tasks MyTasksView). Per-row controls render ONLY when canWrite
// (task:write) — a read-only actor sees tasks, no controls (Ruling 4).

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
            {t.status === 'done' ? '✓' : '○'}
          </span>
          <span className="task-list__title">{t.title}</span>
          <span className="task-list__due"> · {dueLabel(t.due_date)}</span>
          {t.assignee_id !== null ? (
            <span className="task-list__assignee"> · assigned</span>
          ) : (
            <span className="task-list__assignee"> · unassigned</span>
          )}
          {canWrite ? (
            <span className="task-list__controls">
              {' · '}
              <button
                type="button"
                onClick={() => onToggleStatus(t)}
                data-testid="task-toggle"
              >
                {t.status === 'done' ? 'Reopen' : 'Mark done'}
              </button>
              {' · '}
              <button type="button" onClick={() => onEdit(t)} data-testid="task-edit">
                Edit
              </button>
              {' · '}
              <button type="button" onClick={() => onDelete(t)} data-testid="task-delete">
                Delete
              </button>
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
