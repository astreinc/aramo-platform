// Personal (Free) allowance chip and limit banners (handoff §4.10; directive §5, §7 C-3,
// C-4). Built ONLY from GET /v1/sign/billing/account: the app never counts sends.
//   - the daily window is "any 24 hours" — the exact next send time is
//     `allowance.daily.next_available_at`, shown in local time, never "tomorrow" (C-3);
//   - the monthly window resets at `allowance.period_end`;
//   - the copy says "documents" (approved Terms wording); the unit is the envelope (C-4).
import { limitReachedCopy } from '@aramo/sign-client';

import { dateTime, shortDate } from './agreementsModel';
import type { BillingAccount } from './types';

export interface AllowanceWindow {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
}

export interface AllowanceModel {
  readonly month: AllowanceWindow | null;
  readonly day: AllowanceWindow | null;
  readonly nextAvailableAt: string | null;
  readonly resetsAt: string | null;
  readonly dot: 'ok' | 'day_reached' | 'month_reached';
}

export interface LimitBanner {
  readonly kind: 'daily' | 'monthly';
  readonly title: string;
  readonly body: string;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}

/** The chip model for a PERSONAL account with a counted allowance; null otherwise. */
export function allowanceModel(account: BillingAccount | null | undefined): AllowanceModel | null {
  if (!account || account.tenant_kind !== 'PERSONAL') return null;
  const a = account.allowance as Record<string, unknown> | undefined;
  if (!a || a['subscribed'] === false || a['unlimited'] === true) return null;
  const limit = num(a['limit']);
  const used = num(a['used']);
  const remaining = num(a['remaining']);
  const month =
    limit !== null && used !== null
      ? { limit, used, remaining: remaining ?? Math.max(0, limit - used) }
      : null;
  const d = a['daily'] as Record<string, unknown> | undefined;
  const dLimit = num(d?.['limit']);
  const dUsed = num(d?.['used']);
  const day =
    d && dLimit !== null && dUsed !== null
      ? {
          limit: dLimit,
          used: dUsed,
          remaining: num(d['remaining']) ?? Math.max(0, dLimit - dUsed),
        }
      : null;
  if (!month && !day) return null;
  const dot =
    month && month.remaining <= 0
      ? 'month_reached'
      : day && day.remaining <= 0
        ? 'day_reached'
        : 'ok';
  return {
    month,
    day,
    nextAvailableAt: str(d?.['next_available_at']),
    resetsAt: str(a['period_end']),
    dot,
  };
}

export function allowanceChipText(m: AllowanceModel): string {
  const parts: string[] = [];
  if (m.month) parts.push(`${m.month.remaining} of ${m.month.limit} left this month`);
  if (m.day) parts.push(`${m.day.remaining} of ${m.day.limit} left today`);
  return parts.join(' · ');
}

/**
 * The amber limit banner, monthly first (it outlasts the daily one). Client Rule
 * Consolidation C3 (audit row 17) — the words are @aramo/sign-client's limitReachedCopy
 * ("documents"), the same the web shows.
 */
export function limitBanner(m: AllowanceModel | null): LimitBanner | null {
  if (!m) return null;
  if (m.month && m.month.remaining <= 0) {
    return limitReachedCopy('monthly', m.month.limit, m.resetsAt ? shortDate(m.resetsAt) : null);
  }
  if (m.day && m.day.remaining <= 0) {
    return limitReachedCopy('daily', m.day.limit, m.nextAvailableAt ? dateTime(m.nextAvailableAt) : null);
  }
  return null;
}
