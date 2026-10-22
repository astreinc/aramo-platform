import { useEffect, useState } from 'react';

import { billingApi, nextSendTime, type BillingAccount } from '../api';
import { fmtDate } from '../ui';

// Aramo Sign Personal (Free) §4 — the Personal account's usage: the daily window
// (2 a day) and the monthly allowance (5 a period), as the backend's allowance
// ledger reports them (GET /v1/sign/billing/account). Display only: the send
// gate is the backend's.

export const BUSINESS_SIGNUP_URL = '/signup';

export function PersonalUpgradeLink() {
  return (
    <p className="sg-help" data-testid="personal-upgrade">
      Need to send more? <a href={BUSINESS_SIGNUP_URL}>Create a Business organization</a>, or contact Aramo.
    </p>
  );
}

function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 100;
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={limit}
      aria-valuenow={Math.min(used, limit)}
      style={{ height: 6, borderRadius: 3, background: 'var(--line)', overflow: 'hidden', marginTop: 4 }}
    >
      <div style={{ width: `${pct}%`, height: '100%', background: pct < 100 ? 'var(--accent)' : 'var(--bad)' }} />
    </div>
  );
}

/**
 * The allowance chip (signup handoff §5, v1 design): "{n} of 5 left this month ·
 * {n} of 2 left today". Dot: green; amber at 0 left today; red (and the month
 * only) at 0 left this month. Display only.
 */
export function AllowanceChip({ used, limit, daily }: { used: number; limit: number; daily: { used: number; limit: number } | null }) {
  const monthLeft = Math.max(0, limit - used);
  const dayLeft = daily === null ? null : Math.max(0, daily.limit - daily.used);
  const tone = monthLeft === 0 ? 'red' : dayLeft === 0 ? 'amber' : 'green';
  const palette = {
    green: { dot: '#1F7A4D', border: '#E5E9ED', bg: '#F4F6FA' },
    amber: { dot: '#946011', border: '#F2E3BF', bg: '#FFF8EC' },
    red: { dot: '#B3402A', border: '#F3C9C1', bg: '#FBE9E7' },
  }[tone];
  const text =
    monthLeft === 0 || daily === null || dayLeft === null
      ? `${monthLeft} of ${limit} left this month`
      : `${monthLeft} of ${limit} left this month · ${dayLeft} of ${daily.limit} left today`;
  return (
    <span
      data-testid="personal-allowance-chip"
      data-tone={tone}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '3px 10px',
        borderRadius: 999,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: '#1B2730',
        fontSize: 12.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: palette.dot, flex: 'none' }} />
      {text}
    </span>
  );
}

export function PersonalAllowance({ loader = billingApi.account }: { loader?: () => Promise<BillingAccount> }) {
  const [account, setAccount] = useState<BillingAccount | null>(null);
  useEffect(() => {
    let live = true;
    loader()
      .then((a) => live && setAccount(a))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [loader]);

  const a = account?.allowance;
  if (a === undefined || !a.subscribed) return null;
  const daily = a.daily ?? null;
  const monthLimit = a.limit;
  const atDaily = daily !== null && daily.used >= daily.limit;
  const atMonthly = monthLimit !== null && a.used >= monthLimit;
  return (
    <section className="sg-card" style={{ marginTop: 14 }} data-testid="personal-allowance" aria-label="Free plan usage">
      <div className="sg-card__head">
        Free plan
        <span className="sg-card__end" style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {monthLimit !== null ? <AllowanceChip used={a.used} limit={monthLimit} daily={daily} /> : null}
          <span className="sg-muted">Renews {fmtDate(a.period_end)}</span>
        </span>
      </div>
      <div className="sg-card__body sg-grid sg-grid--2">
        {daily !== null ? (
          <div data-testid="personal-allowance-day">
            <strong>
              {daily.used} of {daily.limit}
            </strong>{' '}
            today
            <Meter used={daily.used} limit={daily.limit} label="Envelopes sent today" />
          </div>
        ) : null}
        {monthLimit !== null ? (
          <div data-testid="personal-allowance-month">
            <strong>
              {a.used} of {monthLimit}
            </strong>{' '}
            this month
            <Meter used={a.used} limit={monthLimit} label="Envelopes sent this month" />
          </div>
        ) : null}
      </div>
      {atMonthly || atDaily ? (
        <div className="sg-card__body" style={{ paddingTop: 0 }} role="status">
          <p className="sg-help" style={{ margin: 0 }}>
            {atMonthly
              ? 'You’ve used all your envelopes for this month.'
              : nextSendTime(daily?.next_available_at) !== null
                ? `You’ve reached the limit for 24 hours. Your next send is available at ${nextSendTime(daily?.next_available_at)}.`
                : 'You’ve reached the limit for 24 hours. You can send again later.'}
          </p>
          <PersonalUpgradeLink />
        </div>
      ) : null}
    </section>
  );
}
