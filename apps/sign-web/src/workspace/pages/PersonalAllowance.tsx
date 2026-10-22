import { useEffect, useState } from 'react';

import { billingApi, type BillingAccount } from '../api';
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
        <span className="sg-card__end sg-muted">Renews {fmtDate(a.period_end)}</span>
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
              : daily?.next_available_at
                ? `You’ve reached the daily limit. You can send again after ${fmtDate(daily.next_available_at, true)}.`
                : 'You’ve reached today’s limit. You can send again tomorrow.'}
          </p>
          <PersonalUpgradeLink />
        </div>
      ) : null}
    </section>
  );
}
