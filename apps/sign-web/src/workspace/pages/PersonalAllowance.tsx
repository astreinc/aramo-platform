import { useEffect, useState } from 'react';
import { limitReachedCopy } from '@aramo/sign-client';

import { billingApi, nextSendTime, type BillingAccount } from '../api';
import { FREE_PERSONAL_PLAN_KEY, formatMinor } from '../catalog';
import { fmtDate } from '../ui';

// Aramo Sign Personal (Free) §4 — the Personal account's usage: the daily window
// and the monthly allowance, as the backend's allowance
// ledger reports them (GET /v1/sign/billing/account). Display only: the send
// gate is the backend's.

export const BUSINESS_SIGNUP_URL = '/signup';
// Catalog v2 directive §4.3 — the Personal plan page (Settings → Plan) where Free upgrades to Standard.
export const PERSONAL_PLAN_HREF = '/personal/settings/billing';

// `standard` is false when /account reports `upgrade: null` (the Standard offer is off).
// Client Rule Consolidation C3 (audit row 16) — the price is the server's offer
// (/account `upgrade`); with no offer data the link carries no number.
export function PersonalUpgradeLink({ standard = true, offer = null }: { standard?: boolean; offer?: BillingAccount['upgrade'] } = {}) {
  const price = offer?.price_minor != null ? `${formatMinor(offer.price_minor, offer.currency ?? 'USD')}/month` : '';
  if (!standard) {
    return (
      <p className="sg-help" data-testid="personal-upgrade">
        Need to send more for a team? <a href={BUSINESS_SIGNUP_URL}>Create a Business organization</a>.
      </p>
    );
  }
  return (
    <p className="sg-help" data-testid="personal-upgrade">
      Need to send more?{' '}
      <a href={PERSONAL_PLAN_HREF} data-testid="personal-upgrade-standard">
        Upgrade your plan
      </a>
      {price !== '' ? ` (${price})` : ''}. For a team,{' '}
      <a href={BUSINESS_SIGNUP_URL}>Create a Business organization</a>.
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
 * UAT BIL-11 — the Plan & billing usage, the same two rows the app shows under
 * Account → Plan and usage: "This month · {used} of {limit} used" (resets on the
 * period end) and "Last 24 hours · {used} of {limit} used" (the daily window is
 * any 24 hours, so it is not called "today"). Display only.
 */
export function UsageRows({
  used,
  limit,
  periodEnd,
  daily,
}: {
  used: number;
  limit: number;
  periodEnd: string | null | undefined;
  daily: { used: number; limit: number; next_available_at?: string | null } | null;
}) {
  const nextAt = daily !== null && daily.used >= daily.limit ? nextSendTime(daily.next_available_at) : null;
  return (
    <div data-testid="personal-plan-usage" style={{ display: 'grid', gap: 10 }}>
      <div data-testid="personal-plan-usage-month">
        This month · {used} of {limit} used
        <Meter used={used} limit={limit} label="Envelopes sent this month" />
        {periodEnd ? <div className="sg-muted">Resets {fmtDate(periodEnd)}</div> : null}
      </div>
      {daily !== null ? (
        <div data-testid="personal-plan-usage-day">
          Last 24 hours · {daily.used} of {daily.limit} used
          <Meter used={daily.used} limit={daily.limit} label="Envelopes sent in the last 24 hours" />
          {nextAt !== null ? <div className="sg-muted">You can send again at {nextAt}</div> : null}
        </div>
      ) : null}
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
  const onFree = a.plan_key === FREE_PERSONAL_PLAN_KEY;
  const planLabel = onFree ? 'Free plan' : `${account?.subscription?.plan_name ?? 'Your'} plan`;
  return (
    <section className="sg-card" style={{ marginTop: 14 }} data-testid="personal-allowance" aria-label={`${planLabel} usage`}>
      <div className="sg-card__head">
        {planLabel}
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
            {/* C3 (audit row 17) — the one limit-reached copy ("documents"), shared with the app. */}
            {atMonthly
              ? limitReachedCopy('monthly', monthLimit, a.period_end ? fmtDate(a.period_end) : null).body
              : limitReachedCopy('daily', daily?.limit ?? null, nextSendTime(daily?.next_available_at)).body}
          </p>
          {onFree ? <PersonalUpgradeLink standard={account?.upgrade !== null} offer={account?.upgrade ?? null} /> : null}
        </div>
      ) : null}
    </section>
  );
}
