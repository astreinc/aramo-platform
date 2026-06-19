import { Icons } from '../../ui';
import { PRIORITY_LABELS, TYPE_LABELS } from '../task-vocab';
import {
  TASK_PRIORITY_VALUES,
  TASK_TYPE_VALUES,
  type TaskPriority,
  type TaskType,
} from '../types';

export type TaskViewMode = 'list' | 'board' | 'cal';

// Tasks workspace — the controls row: view toggle (List/Board/Calendar), the
// Type + Priority filters (closed-set, mirror the BE vocab), a Show-completed
// toggle, and the deterministic "Suggested order" toggle (due→priority; NOT
// "AI" — no AI label anywhere).

interface TaskToolbarProps {
  readonly view: TaskViewMode;
  readonly onView: (v: TaskViewMode) => void;
  readonly typeFilter: TaskType | null;
  readonly onTypeFilter: (t: TaskType | null) => void;
  readonly priorityFilter: TaskPriority | null;
  readonly onPriorityFilter: (p: TaskPriority | null) => void;
  readonly showCompleted: boolean;
  readonly onShowCompleted: (v: boolean) => void;
  readonly suggested: boolean;
  readonly onSuggested: (v: boolean) => void;
}

export function TaskToolbar({
  view,
  onView,
  typeFilter,
  onTypeFilter,
  priorityFilter,
  onPriorityFilter,
  showCompleted,
  onShowCompleted,
  suggested,
  onSuggested,
}: TaskToolbarProps) {
  return (
    <div className="rc-tasks__controls">
      <div className="rc-seg" role="group" aria-label="View">
        <button type="button" className={view === 'list' ? 'on' : ''} aria-pressed={view === 'list'} onClick={() => onView('list')} data-testid="view-list">
          <Icons.IconList />
          List
        </button>
        <button type="button" className={view === 'board' ? 'on' : ''} aria-pressed={view === 'board'} onClick={() => onView('board')} data-testid="view-board">
          <Icons.IconColumns />
          Board
        </button>
        <button type="button" className={view === 'cal' ? 'on' : ''} aria-pressed={view === 'cal'} onClick={() => onView('cal')} data-testid="view-cal">
          <Icons.IconClock />
          Calendar
        </button>
      </div>

      <label className="rc-tfilter">
        <span className="rc-sr">Type</span>
        <select
          aria-label="Filter by type"
          value={typeFilter ?? ''}
          onChange={(e) => onTypeFilter(e.target.value === '' ? null : (e.target.value as TaskType))}
          data-testid="filter-type"
        >
          <option value="">All types</option>
          {TASK_TYPE_VALUES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      <label className="rc-tfilter">
        <span className="rc-sr">Priority</span>
        <select
          aria-label="Filter by priority"
          value={priorityFilter ?? ''}
          onChange={(e) =>
            onPriorityFilter(e.target.value === '' ? null : (e.target.value as TaskPriority))
          }
          data-testid="filter-priority"
        >
          <option value="">All priorities</option>
          {TASK_PRIORITY_VALUES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABELS[p]}
            </option>
          ))}
        </select>
      </label>

      <label className="rc-tcheck">
        <input
          type="checkbox"
          checked={showCompleted}
          onChange={(e) => onShowCompleted(e.target.checked)}
          data-testid="show-completed"
        />
        Show completed
      </label>

      <button
        type="button"
        className={`rc-btn${suggested ? ' rc-btn--on' : ''}`}
        aria-pressed={suggested}
        onClick={() => onSuggested(!suggested)}
        disabled={view !== 'list'}
        title="Sort today’s work by due date, then priority"
        data-testid="suggested-order"
      >
        <Icons.IconBolt />
        Suggested order
      </button>
    </div>
  );
}
