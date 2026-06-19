interface ProgressMiniProps {
  readonly value: number;
  readonly max: number;
  /** Optional trailing count label (the mockup's pipeline bar + number). */
  readonly count?: number;
  readonly ariaLabel?: string;
}

// Compact bar + count. Used for pipeline size and openings (x of y). The
// caller decides what value/max mean; this only renders the proportion.
export function ProgressMini({ value, max, count, ariaLabel }: ProgressMiniProps) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <span className="rc-progress">
      <span
        className="rc-progress__bar"
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={ariaLabel}
      >
        <i style={{ width: `${pct}%` }} />
      </span>
      {count != null ? <span className="rc-progress__count num">{count}</span> : null}
    </span>
  );
}
