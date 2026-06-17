import { Icons } from '../../ui';
import type { TaskGroup } from '../workspace';
import type { TaskView } from '../types';

import { TaskRowItem } from './TaskRowItem';

// Tasks workspace — the grouped List view. Ordered due-buckets + Waiting +
// Completed groups (built in ../workspace). Empty → a calm caught-up state.

interface TaskListGroupsProps {
  readonly groups: readonly TaskGroup[];
  readonly now: Date;
  readonly canWrite: boolean;
  readonly selected: ReadonlySet<string>;
  readonly onToggleSelect: (task: TaskView) => void;
  readonly onToggleDone: (task: TaskView) => void;
  readonly onSnooze: (task: TaskView) => void;
  readonly onReschedule: (task: TaskView) => void;
  readonly onOpen: (task: TaskView) => void;
}

export function TaskListGroups({
  groups,
  now,
  canWrite,
  selected,
  onToggleSelect,
  onToggleDone,
  onSnooze,
  onReschedule,
  onOpen,
}: TaskListGroupsProps) {
  if (groups.length === 0) {
    return (
      <div className="rc-tasks__empty" data-testid="tasks-empty">
        <Icons.IconCheck />
        <p>Nothing here — you’re all caught up.</p>
      </div>
    );
  }
  return (
    <div data-testid="tasks-list">
      {groups.map((g) => (
        <section className="rc-tgrp" key={g.key}>
          <header className={`rc-tgrp__head${g.over ? ' rc-tgrp__head--over' : ''}`}>
            <h3>{g.label}</h3>
            <span className="rc-tgrp__count num">{g.tasks.length}</span>
          </header>
          <ul className="rc-tlist">
            {g.tasks.map((t) => (
              <TaskRowItem
                key={t.id}
                task={t}
                now={now}
                canWrite={canWrite}
                selected={selected.has(t.id)}
                onToggleSelect={onToggleSelect}
                onToggleDone={onToggleDone}
                onSnooze={onSnooze}
                onReschedule={onReschedule}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
