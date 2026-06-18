import type { KpiDelta, KpiPace, SparkTone } from '../ui';

import type { RecruiterMetricKey, RecruiterMetricView } from './types';

// Projection of a real BE RecruiterMetricView into KpiCard props. Pure +
// testable. Honest by construction: no prior period → no delta; no goal → no
// pace bar; <2 series points → no sparkline; null value → "—". Nothing is
// fabricated — every adornment is derived from data the BE actually returned.

export interface KpiDisplay {
  readonly key: RecruiterMetricKey;
  readonly label: string;
  readonly value: string;
  readonly unit?: string;
  readonly delta: KpiDelta | null;
  readonly series?: readonly number[];
  readonly seriesTone: SparkTone;
  readonly pace: KpiPace | null;
}

interface MetricMeta {
  readonly label: string;
  readonly unit?: string;
  /** Avg-time-to-submit improves as it falls; counts improve as they rise. */
  readonly lowerIsBetter?: boolean;
  /** The short period word for delta copy ("wk" / "mo"). */
  readonly periodWord: string;
}

const META: Record<RecruiterMetricKey, MetricMeta> = {
  submittals_weekly: { label: 'Submittals · wk', periodWord: 'wk' },
  interviews_weekly: { label: 'Interviews set', periodWord: 'wk' },
  placements_monthly: { label: 'Placements · MTD', periodWord: 'mo' },
  avg_time_to_submit: {
    label: 'Avg time-to-submit',
    unit: 'd',
    lowerIsBetter: true,
    periodWord: 'wk',
  },
};

function formatValue(key: RecruiterMetricKey, v: number): string {
  return key === 'avg_time_to_submit' ? v.toFixed(1) : String(v);
}

function computeDelta(
  m: RecruiterMetricView,
  meta: MetricMeta,
): KpiDelta | null {
  if (m.value === null || m.previous === null) return null;
  const raw = m.value - m.previous;
  if (raw === 0) return { text: `no change vs last ${meta.periodWord}`, dir: 'flat' };
  const improved = meta.lowerIsBetter === true ? raw < 0 : raw > 0;
  const dir = improved ? 'up' : 'down';
  if (m.key === 'avg_time_to_submit') {
    return {
      text: `${Math.abs(raw).toFixed(1)}d ${raw < 0 ? 'faster' : 'slower'}`,
      dir,
    };
  }
  const sign = raw > 0 ? '+' : '−'; // − minus sign
  return { text: `${sign}${Math.abs(raw)} vs last ${meta.periodWord}`, dir };
}

function computePace(
  m: RecruiterMetricView,
  meta: MetricMeta,
): KpiPace | null {
  // Time goals aren't a fill-bar (a ceiling, not a target to accumulate); the
  // mockup shows pace only on the count metrics. Skip when no goal/value.
  if (meta.lowerIsBetter === true) return null;
  if (m.goal === null || m.goal <= 0 || m.value === null) return null;
  const pct = Math.round((m.value / m.goal) * 100);
  const tone = pct >= 100 ? 'ok' : pct >= 67 ? 'warn' : 'hot';
  const label =
    m.period === 'month'
      ? `${m.value} of ${m.goal} goal`
      : `${Math.min(100, pct)}% of weekly goal (${m.goal})`;
  return { pct, label, tone };
}

export function toKpiDisplay(m: RecruiterMetricView): KpiDisplay {
  const meta = META[m.key];
  const delta = computeDelta(m, meta);
  return {
    key: m.key,
    label: meta.label,
    value: m.value === null ? '—' : formatValue(m.key, m.value),
    ...(meta.unit === undefined ? {} : { unit: meta.unit }),
    delta,
    ...(m.series.length >= 2 ? { series: m.series } : {}),
    seriesTone: delta?.dir ?? 'flat',
    pace: computePace(m, meta),
  };
}

// Fixed display order for the four desk KPIs.
export const KPI_ORDER: readonly RecruiterMetricKey[] = [
  'submittals_weekly',
  'interviews_weekly',
  'placements_monthly',
  'avg_time_to_submit',
];
