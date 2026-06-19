import { StatusPill } from '../../ui';
import {
  OWNER_LABELS,
  STATUS_LABELS,
  TYPE_LABELS,
  STATUS_TONE,
  ownerIcon,
  typeIcon,
} from '../task-vocab';
import { buildBoard, dueShortLabel } from '../workspace';
import type { TaskStatus, TaskView } from '../types';

// Tasks workspace — the Board view (by status). Active columns + a Done drop
// target (mockup parity). Moving a card between columns PATCHes status; drag is
// progressive-enhancement, the per-card status <select> is the keyboard path.

interface TaskBoardProps {
  readonly tasks: readonly TaskView[];
  readonly now: Date;
  readonly canWrite: boolean;
  readonly onMove: (task: TaskView, status: TaskStatus) => void;
  readonly onOpen: (task: TaskView) => void;
}

export function TaskBoard({ tasks, now, canWrite, onMove, onOpen }: TaskBoardProps) {
  const columns = buildBoard(tasks);
  return (
    <div className="rc-board" data-testid="tasks-board">
      {columns.map((col) => (
        <section
          className="rc-bcol"
          key={col.key}
          onDragOver={(e) => {
            if (canWrite) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!canWrite) return;
            const id = e.dataTransfer.getData('text/plain');
            const t = tasks.find((x) => x.id === id);
            if (t && t.status !== col.key) onMove(t, col.key);
          }}
        >
          <header className="rc-bcol__head">
            <span className={`rc-bdot rc-bdot--${col.key}`} aria-hidden="true" />
            <h3>{STATUS_LABELS[col.key]}</h3>
            <span className="rc-bcol__count num">{col.tasks.length}</span>
          </header>
          <div className="rc-bcol__body">
            {col.tasks.map((t) => (
              <article
                key={t.id}
                className={`rc-bcard${t.priority !== null ? ` rc-bcard--p-${t.priority}` : ''}`}
                draggable={canWrite}
                onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)}
                data-testid="board-card"
              >
                <div className="rc-bcard__top">
                  {t.type !== null ? (
                    <span className={`rc-ttype rc-ttype--${t.type}`} title={TYPE_LABELS[t.type]}>
                      {typeIcon(t.type)}
                    </span>
                  ) : null}
                  <button type="button" className="rc-bcard__title" onClick={() => onOpen(t)}>
                    {t.title}
                  </button>
                </div>
                <div className="rc-bcard__meta">
                  <span className={`rc-tlink rc-tlink--${t.owner_type}`}>
                    {ownerIcon(t.owner_type)}
                    {OWNER_LABELS[t.owner_type]}
                  </span>
                  <span className="rc-bcard__due">{dueShortLabel(t, now)}</span>
                </div>
                {canWrite ? (
                  <label className="rc-bcard__move">
                    <span className="rc-sr">Move {t.title} to</span>
                    <select
                      aria-label={`Move ${t.title} to status`}
                      value={t.status}
                      onChange={(e) => onMove(t, e.target.value as TaskStatus)}
                      data-testid="board-move"
                    >
                      {(['open', 'in_progress', 'waiting', 'done', 'cancelled'] as TaskStatus[]).map(
                        (s) => (
                          <option key={s} value={s}>
                            {STATUS_LABELS[s]}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                ) : (
                  <StatusPill tone={STATUS_TONE[t.status]} dot>
                    {STATUS_LABELS[t.status]}
                  </StatusPill>
                )}
              </article>
            ))}
            {col.tasks.length === 0 ? <p className="rc-bcol__empty">—</p> : null}
          </div>
        </section>
      ))}
    </div>
  );
}
