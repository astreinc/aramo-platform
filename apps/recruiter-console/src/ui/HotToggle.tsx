import { IconFlame } from './icons';

interface HotToggleProps {
  /** Current hot state (the talent's is_hot flag). */
  readonly hot: boolean;
  /** Flip handler — receives the next boolean. Omit/disabled → read-only. */
  readonly onToggle?: (next: boolean) => void;
  /** Talent name, woven into the accessible label/title. */
  readonly label?: string;
  readonly disabled?: boolean;
}

// Row-level triage affordance — a single toggle bound to the EXISTING is_hot
// flag. is_hot is a NON-ORDINAL preference mark ("this one matters to me"),
// not an ordinal ranking (R10-clean): it may be filtered (the Talent "hot" facet)
// but is never a sort key and never aggregated into an average. Filled flame =
// hot, outline = not. Accessible: a real <button> (keyboard), aria-pressed
// reflects state, title gives the action. The caller owns optimistic update +
// rollback. Read-only (no onToggle / disabled) still shows the state.
export function HotToggle({
  hot,
  onToggle,
  label = 'this talent',
  disabled = false,
}: HotToggleProps) {
  const interactive = onToggle !== undefined && !disabled;
  return (
    <button
      type="button"
      className={`rc-hot${hot ? ' rc-hot--on' : ''}`}
      aria-pressed={hot}
      aria-label={hot ? `${label} is marked hot` : `Mark ${label} as hot`}
      title={hot ? 'Marked hot — click to unmark' : 'Mark as hot'}
      disabled={!interactive}
      onClick={interactive ? () => onToggle(!hot) : undefined}
    >
      <IconFlame aria-hidden="true" />
    </button>
  );
}
