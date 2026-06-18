import { describe, expect, it } from 'vitest';

import { toKpiDisplay } from './kpi';
import type { RecruiterMetricView } from './types';

function metric(over: Partial<RecruiterMetricView>): RecruiterMetricView {
  return {
    key: 'submittals_weekly',
    value: 7,
    previous: 5,
    series: [3, 5, 7],
    goal: 10,
    period: 'week',
    ...over,
  };
}

describe('toKpiDisplay', () => {
  it('formats an improving count delta as up-tone "+N vs last wk" + a pace bar', () => {
    const d = toKpiDisplay(metric({}));
    expect(d.value).toBe('7');
    expect(d.delta).toEqual({ text: '+2 vs last wk', dir: 'up' });
    expect(d.pace).toEqual({ pct: 70, tone: 'warn', label: '70% of weekly goal (10)' });
    expect(d.series).toEqual([3, 5, 7]);
  });

  it('treats avg-time-to-submit as lower-is-better (fall = up tone, "faster"), no pace', () => {
    const d = toKpiDisplay(
      metric({ key: 'avg_time_to_submit', value: 1.8, previous: 2.2, goal: null }),
    );
    expect(d.value).toBe('1.8');
    expect(d.unit).toBe('d');
    expect(d.delta).toEqual({ text: '0.4d faster', dir: 'up' });
    expect(d.pace).toBeNull(); // time goals aren't a fill bar
  });

  it('omits the delta when there is no prior period (no fabrication)', () => {
    const d = toKpiDisplay(metric({ previous: null }));
    expect(d.delta).toBeNull();
  });

  it('omits the pace bar when no goal is configured', () => {
    const d = toKpiDisplay(metric({ goal: null }));
    expect(d.pace).toBeNull();
  });

  it('shows an em-dash and no sparkline when the value/series is empty', () => {
    const d = toKpiDisplay(
      metric({ key: 'avg_time_to_submit', value: null, previous: null, series: [], goal: null }),
    );
    expect(d.value).toBe('—');
    expect(d.delta).toBeNull();
    expect(d.series).toBeUndefined();
  });

  it('flat delta when value equals previous', () => {
    const d = toKpiDisplay(metric({ value: 5, previous: 5 }));
    expect(d.delta?.dir).toBe('flat');
  });
});
