import { Button } from '@aramo/fe-foundation';

import { Pill, SkeletonPanel, formatDate, formatRelative, formatTimestamp } from '../components';
import type { PlatformTenantSign } from '../platform-api';

import {
  billingEventLabel,
  billingOutcomePill,
  subscriptionPill,
  subscriptionSourceLabel,
} from './tenant-labels';

// PLATFORM-UX-1 F-5 (handoff §6.3 Aramo Sign) — the operator's READ-ONLY view
// of a tenant's Aramo Sign account: plan + subscription pill (never "—"; no
// subscription is "No subscription"), capabilities, Sign enabled, Source with
// its mono code (FREE → "Free (Sign Personal)"), eligibility, storage, online
// billing, the period's usage with a 6px bar (or the unsubscribed allowance
// state), the dates, and the billing events. No actions: plan, subscription
// and capability changes are governed commercial actions.

function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${Math.round((n / 1024 ** 3) * 10) / 10} GB`;
  if (n >= 1024 ** 2) return `${Math.round((n / 1024 ** 2) * 10) / 10} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/** "2.4 GB of 25 GB" · "4 MB (not limited)" · "Not metered". */
export function storageLine(storage: PlatformTenantSign['storage']): string {
  if (storage === null || storage === undefined) return 'Not metered';
  if (storage.unlimited || storage.limit === null) return `${bytes(storage.used)} (not limited)`;
  return `${bytes(storage.used)} of ${bytes(storage.limit)}`;
}

/** The usage headline and bar width (null width = no bar). */
export function usageLine(allowance: PlatformTenantSign['allowance']): { text: string; pct: number | null } {
  if (!allowance.subscribed) {
    return { text: `Not metered · ${subscriptionPill(allowance.state ?? 'NONE').label}`, pct: null };
  }
  if (allowance.limit === null) return { text: `${allowance.used} envelopes (unlimited)`, pct: null };
  const pct = allowance.limit > 0 ? Math.min(100, Math.round((allowance.used / allowance.limit) * 100)) : 100;
  return { text: `${allowance.used} of ${allowance.limit} envelopes`, pct };
}

const yesNo = (b: boolean): string => (b ? 'Yes' : 'No');

export interface TenantSignPanelProps {
  readonly data: PlatformTenantSign | null;
  readonly failed: boolean;
  readonly onRetry: () => void;
}

export function TenantSignPanel({ data, failed, onRetry }: TenantSignPanelProps) {
  const banner = (
    <div className="pt-note" role="note">
      Read-only. Plan, subscription and capability changes are governed commercial actions and aren&apos;t made from
      this console.
    </div>
  );
  if (failed) {
    return (
      <div data-testid="tenant-sign">
        {banner}
        <section className="pt-card pt-w900">
          <div role="alert" className="pw-alert pw-alert--error pt-panel-alert">
            <span>
              <b>Couldn’t load the Aramo Sign account.</b>
            </span>
            <Button unstyled className="pw-btn pw-btn--secondary pw-btn--30 pt-panel-alert__action" onClick={onRetry}>
              Try again
            </Button>
          </div>
        </section>
      </div>
    );
  }
  if (data === null) {
    return (
      <div data-testid="tenant-sign">
        {banner}
        <section className="pt-card pt-w900">
          <SkeletonPanel />
        </section>
      </div>
    );
  }

  const sub = data.subscription;
  if (sub === null) {
    const none = subscriptionPill(data.allowance.subscribed ? 'NONE' : (data.allowance.state ?? 'NONE'));
    return (
      <div data-testid="tenant-sign">
        {banner}
        <section className="pt-card pt-w900 pt-pad20">
          <div className="pt-none-row">
            <b>Subscription</b>
            <Pill tone={none.tone}>{none.label}</Pill>
            <span className="pt-code-faint pt-code-faint--115">{data.allowance.subscribed ? 'NONE' : (data.allowance.state ?? 'NONE')}</span>
          </div>
          <p className="pt-none-text" data-testid="tenant-sign-plan">
            This tenant has no Sign subscription. Sign enabled: <b>{yesNo(data.sign_entitled)}</b>. Usage is not metered.
          </p>
        </section>
      </div>
    );
  }

  const subP = subscriptionPill(sub.status);
  const usage = usageLine(data.allowance);
  const dates: readonly (readonly [string, string | null | undefined])[] = [
    ['Started', sub.started_at],
    ['Current period ends', sub.current_period_end],
    ['Cancellation', sub.cancel_at_period_end ? sub.current_period_end : null],
    ['Payment grace until', sub.grace_until],
    ['Ended', sub.ended_at],
    ['Commitment ends', sub.commitment_end ?? null],
  ];
  const lapsed = sub.eligibility_state === 'LAPSED';

  return (
    <div data-testid="tenant-sign">
      {banner}
      <div className="pt-sign-grid">
        <section className="pt-card pt-pad">
          <div className="pt-plan" data-testid="tenant-sign-plan">
            <b className="pt-b15">{sub.plan_name}</b>
            <Pill tone={subP.tone}>{subP.label}</Pill>
            {!sub.sending ? <span className="pt-notsending">(not sending)</span> : null}
          </div>
          <dl className="pt-dl170">
            <dt>Capabilities</dt>
            <dd className="pt-dd-mono">{data.capabilities.join(', ') || 'None'}</dd>
            <dt>Sign enabled</dt>
            <dd>{yesNo(data.sign_entitled)}</dd>
            <dt>Source</dt>
            <dd>
              {subscriptionSourceLabel(sub.source)} <span className="pt-code-faint">{sub.source}</span>
            </dd>
            <dt>Eligibility</dt>
            <dd data-testid="tenant-sign-eligibility">
              {lapsed ? <Pill tone="warn">Lapsed</Pill> : <Pill tone="ok">Eligible</Pill>}
            </dd>
            <dt>Storage</dt>
            <dd data-testid="tenant-sign-storage">{storageLine(data.storage)}</dd>
            <dt>Online billing</dt>
            <dd>{data.billing_available ? 'Available' : 'Not available'}</dd>
          </dl>
        </section>
        <section className="pt-card pt-pad">
          <b className="pt-b15">Usage this period</b>
          <div className="pt-usage" data-testid="tenant-sign-usage">
            {usage.text}
          </div>
          {usage.pct !== null ? (
            <div className="pt-bar" aria-hidden="true">
              <div className="pt-bar__fill" style={{ width: `${usage.pct}%` }} />
            </div>
          ) : null}
          <dl className="pt-dl170 pt-dl-top">
            {dates.map(([k, v]) => (
              <DateRow key={k} label={k} value={v ?? null} />
            ))}
          </dl>
          {sub.cancel_requested_within_commitment ? (
            <p className="pt-none-text" data-testid="tenant-sign-commitment">
              Cancellation requested inside the commitment.
            </p>
          ) : null}
        </section>
      </div>
      <section className="pt-card pt-card--clip pt-w1100 pt-mt16">
        <div className="pt-card__head pt-card__head--14">
          <h2 className="pt-card__title">Recent billing events</h2>
        </div>
        {data.billing_events.length === 0 ? (
          <div className="pt-empty-pad">No billing events received.</div>
        ) : (
          <div className="pt-scroll">
            <table className="pt-table pt-min640" data-testid="tenant-sign-events">
              <thead>
                <tr>
                  <th className="pt-th pt-th--first20">Event</th>
                  <th className="pt-th">Received</th>
                  <th className="pt-th">Outcome</th>
                  <th className="pt-th pt-th--last">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.billing_events.map((e, i) => {
                  const out = billingOutcomePill(e.outcome);
                  return (
                    <tr key={`${e.received_at}-${i}`}>
                      <td className="pt-td pt-td--first20 pt-td--event">
                        {billingEventLabel(e.event_type)}
                        <div className="pt-code-faint">{e.event_type}</div>
                      </td>
                      <td className="pt-td pt-td--mono12">{formatTimestamp(e.received_at)}</td>
                      <td className="pt-td">
                        <Pill tone={out.tone}>{out.label}</Pill>
                      </td>
                      <td className="pt-td pt-td--last pt-td--detail">{e.detail ?? 'No detail'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function DateRow({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value ? formatDate(value) : 'None'} {value ? <span className="pt-rel">{formatRelative(value)}</span> : null}
      </dd>
    </>
  );
}
