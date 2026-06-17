import type { SummaryCounts, SummaryKey } from '../workspace';

// Tasks workspace — the summary metric strip. Each card is a click-filter:
// Overdue / Due today / Upcoming filter the due dimension; Waiting / Done are
// status views. Selecting a card toggles the corresponding filter.

interface TaskSummaryCardsProps {
  readonly counts: SummaryCounts;
  readonly activeKey: SummaryKey | null;
  readonly onSelect: (key: SummaryKey) => void;
}

const CARDS: ReadonlyArray<{ key: SummaryKey; label: string; over?: boolean }> = [
  { key: 'overdue', label: 'Overdue', over: true },
  { key: 'today', label: 'Due today' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
];

export function TaskSummaryCards({ counts, activeKey, onSelect }: TaskSummaryCardsProps) {
  return (
    <div className="rc-tsummary" role="group" aria-label="Task summary">
      {CARDS.map((c) => {
        const value = counts[c.key];
        const on = activeKey === c.key;
        return (
          <button
            type="button"
            key={c.key}
            className={`rc-scard${c.over ? ' rc-scard--over' : ''}${on ? ' rc-scard--on' : ''}`}
            aria-pressed={on}
            onClick={() => onSelect(c.key)}
            data-testid={`summary-${c.key}`}
          >
            <span className="rc-scard__v num">{value}</span>
            <span className="rc-scard__l">{c.label}</span>
          </button>
        );
      })}
    </div>
  );
}
