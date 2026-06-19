import { TYPE_LABELS } from '../task-vocab';
import { buildCalendar } from '../workspace';
import type { TaskView } from '../types';

// Tasks workspace — the Calendar view (current week, Mon–Sun; by due_date).
// Items are type-colour-coded. Tasks due outside the visible week (or undated)
// are counted honestly in the footnote — never faked onto a day.

interface TaskCalendarProps {
  readonly tasks: readonly TaskView[];
  readonly now: Date;
  readonly onOpen: (task: TaskView) => void;
}

export function TaskCalendar({ tasks, now, onOpen }: TaskCalendarProps) {
  const week = buildCalendar(tasks, now);
  return (
    <div className="rc-cal" data-testid="tasks-calendar">
      <div className="rc-cal__grid">
        {week.days.map((d) => (
          <div className={`rc-calday${d.isToday ? ' rc-calday--today' : ''}`} key={d.weekday}>
            <div className="rc-calday__head">
              <span className="rc-calday__dn">{d.weekday}</span>
              <span className="rc-calday__dd num">{d.dayOfMonth}</span>
              <span className="rc-calday__dc">
                {d.tasks.length > 0 ? `${d.tasks.length} item${d.tasks.length > 1 ? 's' : ''}` : '—'}
              </span>
            </div>
            <div className="rc-calday__body">
              {d.tasks.slice(0, 6).map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className={`rc-calitem${t.type !== null ? ` rc-calitem--${t.type}` : ''}`}
                  onClick={() => onOpen(t)}
                  data-testid="cal-item"
                  title={t.type !== null ? TYPE_LABELS[t.type] : undefined}
                >
                  <span className="rc-calitem__t">{t.title}</span>
                </button>
              ))}
              {d.tasks.length > 6 ? (
                <span className="rc-calmore">+{d.tasks.length - 6} more</span>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {week.offWeek > 0 || week.noDate > 0 ? (
        <p className="rc-cal__foot">
          {week.offWeek > 0 ? `${week.offWeek} outside this week` : null}
          {week.offWeek > 0 && week.noDate > 0 ? ' · ' : null}
          {week.noDate > 0 ? `${week.noDate} with no date` : null}
        </p>
      ) : null}
    </div>
  );
}
