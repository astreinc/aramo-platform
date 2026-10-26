import { Pill } from './Pill';

// CCP-UI-V12 (CCP-UI v1.1 handoff §13.1, §13.10) — Finance › Renewals "Remaining": "n days left"
// (info at 30 days or fewer, neutral otherwise) or "Lapsed n d ago" (warn).

export interface RenewalRemainingPillProps {
  readonly endDate: Date;
  readonly now: Date;
  /** The server's whole-day count (C6 `days_until`), which wins over the local difference. */
  readonly days?: number;
}

const DAY = 86_400_000;

/** Whole days from `now` to `endDate` (the design's `dLeft`: rounded). */
export function daysLeft(endDate: Date, now: Date): number {
  return Math.round((endDate.getTime() - now.getTime()) / DAY);
}

export function renewalRemaining(endDate: Date, now: Date, days?: number): { readonly label: string; readonly tone: 'info' | 'neutral' | 'warn' } {
  const d = days ?? daysLeft(endDate, now);
  if (d < 0) return { label: `Lapsed ${-d} d ago`, tone: 'warn' };
  return { label: `${d} days left`, tone: d <= 30 ? 'info' : 'neutral' };
}

export function RenewalRemainingPill({ endDate, now, days }: RenewalRemainingPillProps) {
  const r = renewalRemaining(endDate, now, days);
  return <Pill tone={r.tone}>{r.label}</Pill>;
}
