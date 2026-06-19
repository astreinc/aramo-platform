import type { ReactNode } from 'react';

interface MetricCardProps {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly icon?: ReactNode;
  /**
   * A plain, contract-backed sub-line (e.g. "2 hot"). PER LEAD GAP #6 there
   * are NO deltas/goals/trend arrows — those windows are unmodelled, so this
   * atom deliberately has no up/down delta variant.
   */
  readonly hint?: ReactNode;
}

export function MetricCard({ label, value, icon, hint }: MetricCardProps) {
  return (
    <div className="rc-metric">
      <div className="rc-metric__k">
        {icon}
        {label}
      </div>
      <div className="rc-metric__n">{value}</div>
      {hint != null ? <div className="rc-metric__hint">{hint}</div> : null}
    </div>
  );
}
