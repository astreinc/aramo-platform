import { Link } from 'react-router-dom';

import { Icons } from '../../ui';
import {
  OWNER_LABELS,
  TYPE_LABELS,
  ownerHref,
  ownerIcon,
  typeIcon,
} from '../task-vocab';
import { dueBucket, dueShortLabel } from '../workspace';
import type { TaskView } from '../types';

// Tasks workspace — a single list row (mockup .trow). Priority dot + type icon
// + title + owner-link chip + due + hover actions. Controls render only when
// canWrite. Selection checkbox drives the bulk bar.

interface TaskRowItemProps {
  readonly task: TaskView;
  readonly now: Date;
  readonly canWrite: boolean;
  readonly selected: boolean;
  readonly onToggleSelect: (task: TaskView) => void;
  readonly onToggleDone: (task: TaskView) => void;
  readonly onSnooze: (task: TaskView) => void;
  readonly onReschedule: (task: TaskView) => void;
  readonly onOpen: (task: TaskView) => void;
}

export function TaskRowItem({
  task,
  now,
  canWrite,
  selected,
  onToggleSelect,
  onToggleDone,
  onSnooze,
  onReschedule,
  onOpen,
}: TaskRowItemProps) {
  const done = task.status === 'done' || task.status === 'cancelled';
  const overdue = !done && task.status !== 'waiting' && dueBucket(task, now) === 'overdue';
  const href = ownerHref(task.owner_type, task.owner_id);
  const ownerName = OWNER_LABELS[task.owner_type];

  return (
    <li
      className={`rc-trow${done ? ' rc-trow--done' : ''}${selected ? ' rc-trow--sel' : ''}`}
      data-testid="task-row"
    >
      {canWrite ? (
        <input
          type="checkbox"
          className="rc-trow__sel"
          aria-label={`Select ${task.title}`}
          checked={selected}
          onChange={() => onToggleSelect(task)}
          data-testid="task-select"
        />
      ) : null}

      {canWrite ? (
        <button
          type="button"
          className="rc-trow__check"
          aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          aria-pressed={done}
          onClick={() => onToggleDone(task)}
          data-testid="task-toggle"
        >
          <Icons.IconCheck />
        </button>
      ) : (
        <span className="rc-trow__check rc-trow__check--ro" aria-hidden="true">
          {done ? <Icons.IconCheck /> : null}
        </span>
      )}

      {task.priority !== null ? (
        <span
          className={`rc-pdot rc-pdot--${task.priority}`}
          aria-label={`Priority ${task.priority}`}
          title={`Priority: ${task.priority}`}
        />
      ) : (
        <span className="rc-pdot rc-pdot--none" aria-hidden="true" />
      )}

      {task.type !== null ? (
        <span className={`rc-ttype rc-ttype--${task.type}`} title={TYPE_LABELS[task.type]}>
          {typeIcon(task.type)}
        </span>
      ) : (
        <span className="rc-ttype rc-ttype--none" aria-hidden="true" />
      )}

      <div className="rc-trow__main">
        <div className="rc-trow__title">
          <button type="button" className="rc-trow__titlebtn" onClick={() => onOpen(task)}>
            {task.title}
          </button>
          {task.source === 'auto' ? <span className="rc-trow__auto">Auto</span> : null}
        </div>
        <div className="rc-trow__meta">
          {href !== null ? (
            <Link className={`rc-tlink rc-tlink--${task.owner_type}`} to={href}>
              {ownerIcon(task.owner_type)}
              {ownerName}
            </Link>
          ) : (
            <span className={`rc-tlink rc-tlink--${task.owner_type}`}>
              {ownerIcon(task.owner_type)}
              {ownerName}
            </span>
          )}
          {task.type !== null ? <span className="rc-trow__typelbl">{TYPE_LABELS[task.type]}</span> : null}
        </div>
      </div>

      <span className={`rc-tdue${overdue ? ' rc-tdue--over' : ''}`}>
        {dueShortLabel(task, now)}
      </span>

      {canWrite ? (
        <div className="rc-trow__act">
          <button type="button" title="Snooze 1 day" aria-label={`Snooze ${task.title}`} onClick={() => onSnooze(task)} data-testid="task-snooze">
            <Icons.IconClock />
          </button>
          <button type="button" title="Reschedule to tomorrow" aria-label={`Reschedule ${task.title}`} onClick={() => onReschedule(task)} data-testid="task-reschedule">
            <Icons.IconChevronRight />
          </button>
          <button type="button" title="Open" aria-label={`Open ${task.title}`} onClick={() => onOpen(task)} data-testid="task-open">
            <Icons.IconOpen />
          </button>
        </div>
      ) : null}
    </li>
  );
}
