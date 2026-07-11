export type SparkTone = 'up' | 'down' | 'flat';

interface SparklineProps {
  /** Recent per-period series, oldest→newest. Real data only (no fabrication). */
  readonly data: readonly number[];
  /** Colour intent — up=good (green), down=bad (hot), flat=neutral. */
  readonly tone?: SparkTone;
}

// A small inline SVG line chart for the KPI cards. Pure projection of the BE
// metric series — it renders whatever real points it's given (and nothing when
// there aren't at least two). Ported from the mockup's spark() into a token-
// driven component (stroke = currentColor, tinted by tone).
export function Sparkline({ data, tone = 'up' }: SparklineProps) {
  if (data.length < 2) return null;
  const w = 100;
  const h = 24;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  const rg = mx - mn || 1;
  const y = (v: number) => h - 3 - ((v - mn) / rg) * (h - 6);
  const pts = data
    .map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  const last = data[data.length - 1] ?? 0;
  return (
    <svg
      className={`rc-spark rc-spark--${tone}`}
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={w} cy={y(last).toFixed(1)} r={2.2} fill="currentColor" />
    </svg>
  );
}
