import type { ReactNode } from 'react';

import { Sparkline, type SparkTone } from './Sparkline';

export interface KpiDelta {
  /** Already-formatted delta copy, e.g. "+2 vs last wk" or "0.4d faster". */
  readonly text: string;
  readonly dir: 'up' | 'down' | 'flat';
}

export interface KpiPace {
  /** 0–100 progress toward the goal. */
  readonly pct: number;
  /** e.g. "70% of weekly goal (10)". */
  readonly label: string;
  readonly tone: 'ok' | 'warn' | 'hot';
}

interface KpiCardProps {
  readonly label: ReactNode;
  /** The formatted current value (or "—" when the window is empty). */
  readonly value: ReactNode;
  readonly unit?: string;
  /** Period-over-period delta. Omit/null when the prior period isn't computable. */
  readonly delta?: KpiDelta | null;
  /** Recent series for the sparkline (real data; omit when none). */
  readonly series?: readonly number[];
  readonly seriesTone?: SparkTone;
  /** Goal-progress bar. Omit/null when no goal/target is configured. */
  readonly pace?: KpiPace | null;
}

// The My Desk KPI card — mockup parity: label, big number (+unit), a trend
// delta, a sparkline, and a goal-progress bar. Every adornment is optional and
// only renders when the BE actually backs it: no prior period → no delta; no
// goal configured → no pace bar; <2 points → no sparkline. The design renders
// regardless; the data behind each piece is real.
export function KpiCard({
  label,
  value,
  unit,
  delta,
  series,
  seriesTone = 'up',
  pace,
}: KpiCardProps) {
  return (
    <div className="rc-kpi">
      <div className="rc-kpi__k">{label}</div>
      <div className="rc-kpi__v num">
        {value}
        {unit != null ? <small>{unit}</small> : null}
      </div>
      {delta != null ? (
        <div className="rc-kpi__d">
          <span className={`rc-kpi__delta rc-kpi__delta--${delta.dir}`}>
            {delta.dir === 'up' ? '▲' : delta.dir === 'down' ? '▼' : '–'}{' '}
            {delta.text}
          </span>
        </div>
      ) : null}
      {series != null ? <Sparkline data={series} tone={seriesTone} /> : null}
      {pace != null ? (
        <div className={`rc-pace rc-pace--${pace.tone}`}>
          <div className="rc-pace__track">
            <div
              className="rc-pace__fill"
              style={{ width: `${Math.max(0, Math.min(100, pace.pct))}%` }}
            />
          </div>
          <div className="rc-pace__l">{pace.label}</div>
        </div>
      ) : null}
    </div>
  );
}
