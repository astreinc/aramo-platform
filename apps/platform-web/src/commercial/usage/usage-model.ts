// CCP-UI-V12 — the pure model behind Usage › Consumption (CCP-UI v1.1 handoff §13.4). Counts only.
// Sorted by tenant name, then period (newest first): never by volume, never a "top tenants" list.

import type { UsageReconStatus } from '../../components';
import { dayLabel } from '../finance/finance-model';

import type { UsagePeriod, UsageReconciliation } from './usage-api';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The banner state: NOT_RECONCILED refuses; buckets written after the last run (or no run) are pending. */
export function bannerStatus(r: UsageReconciliation): UsageReconStatus {
  if (r.status === 'NOT_RECONCILED') return 'NOT_RECONCILED';
  if (r.status === 'NOT_RUN' || r.metrics.some((m) => m.buckets.pending > 0)) return 'PENDING';
  return 'RECONCILED';
}

export function mismatchCount(r: UsageReconciliation): number {
  return r.metrics.reduce((a, m) => a + m.mismatch_count, 0);
}

/** The last run's time: the newest metric watermark (the read carries no run mode, MBC-V12-6). */
export function lastRunAt(r: UsageReconciliation): Date | null {
  const t = r.metrics.map((m) => (m.watermark === null ? null : Date.parse(m.watermark))).filter((x): x is number => x !== null && !Number.isNaN(x));
  return t.length === 0 ? null : new Date(Math.max(...t));
}

/** "2026-10" (UTC month of the period start). */
export function periodKey(p: Pick<UsagePeriod, 'period_start'>): string {
  return p.period_start.slice(0, 7);
}

/** "October 2026". */
export function periodLabel(key: string): string {
  const [y, m] = key.split('-');
  return `${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "8 Oct – 7 Nov" (the inclusive last day of an end-exclusive period). */
export function rangeLabel(p: Pick<UsagePeriod, 'period_start' | 'period_end'>): string {
  const s = new Date(p.period_start);
  const a = `${s.getUTCDate()} ${MON3[s.getUTCMonth()]}`;
  if (p.period_end === null) return `${a} – open`;
  const e = new Date(Date.parse(p.period_end) - 86_400_000);
  return `${a} – ${e.getUTCDate()} ${MON3[e.getUTCMonth()]}`;
}

export const num = (n: number): string => n.toLocaleString('en-US');

export interface UsageRow {
  readonly period: UsagePeriod;
  readonly tenant: string;
  readonly key: string;
  readonly label: string;
  readonly range: string;
  readonly sent: string;
  readonly historical: string;
  readonly reserved: string;
  readonly allowance: string;
  readonly aligned: boolean;
}

export function usageRows(periods: readonly UsagePeriod[], filter: string, tenantName: (id: string) => string): UsageRow[] {
  return periods
    .filter((p) => filter === 'all' || periodKey(p) === filter)
    .map((p) => ({
      period: p,
      tenant: tenantName(p.tenant_id),
      key: periodKey(p),
      label: periodLabel(periodKey(p)),
      range: rangeLabel(p),
      sent: num(p.counts.consumed_send),
      historical: num(p.counts.consumed_historical),
      reserved: num(p.counts.reserved),
      allowance: p.unlimited === true ? 'Unlimited' : p.included_quantity === null ? '—' : num(p.included_quantity),
      aligned: p.alignment === 'ALIGNED',
    }))
    .sort((a, b) => (a.tenant === b.tenant ? (a.period.period_start < b.period.period_start ? 1 : -1) : a.tenant.localeCompare(b.tenant)));
}

/** The Period select: every month the read returned, newest first. */
export function periodOptions(periods: readonly UsagePeriod[]): { readonly value: string; readonly label: string }[] {
  return [...new Set(periods.map(periodKey))].sort((a, b) => (a < b ? 1 : -1)).map((k) => ({ value: k, label: periodLabel(k) }));
}

export { dayLabel };
