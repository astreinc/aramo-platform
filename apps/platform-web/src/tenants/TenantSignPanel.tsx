import { useEffect, useState } from 'react';
import { InlineAlert } from '@aramo/fe-foundation';

import { platformApi, type PlatformTenantSign } from '../platform-api';

// Aramo Sign launch — the operator's READ-ONLY view of a tenant's Aramo Sign
// account: product capabilities, the effective subscription, this period's
// usage and the recent billing-provider events. Support visibility only; there
// are deliberately no actions here (capability and subscription changes are
// governed commercial actions).

function fmt(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

export function TenantSignPanel({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<PlatformTenantSign | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    platformApi
      .getTenantSign(tenantId)
      .then((d) => live && setData(d))
      .catch(() => live && setError('Could not load the Aramo Sign account.'));
    return () => {
      live = false;
    };
  }, [tenantId]);

  if (error !== null) return <InlineAlert variant="error">{error}</InlineAlert>;
  if (data === null) return <p>Loading…</p>;
  const sub = data.subscription;
  const a = data.allowance;
  return (
    <div data-testid="tenant-sign">
      <dl className="pw-facts">
        <dt>Capabilities</dt>
        <dd>{data.capabilities.join(', ') || '—'}</dd>
        <dt>Aramo Sign</dt>
        <dd>{data.sign_entitled ? 'Enabled' : 'Not enabled'}</dd>
        <dt>Plan</dt>
        <dd data-testid="tenant-sign-plan">{sub === null ? 'No subscription' : `${sub.plan_name} · ${sub.status}${sub.sending ? '' : ' (not sending)'}`}</dd>
        {sub !== null ? (
          <>
            <dt>Source</dt>
            <dd>{sub.source === 'SELF_SERVICE' ? 'Self-service (Stripe)' : sub.source === 'MANUAL' ? 'Arranged by Aramo' : 'Development'}</dd>
            <dt>Started</dt>
            <dd>{fmt(sub.started_at)}</dd>
            <dt>Current period ends</dt>
            <dd>{fmt(sub.current_period_end)}</dd>
            {sub.cancel_at_period_end ? (
              <>
                <dt>Cancellation</dt>
                <dd>Ends at period end</dd>
              </>
            ) : null}
            {sub.grace_until !== null ? (
              <>
                <dt>Payment grace until</dt>
                <dd>{fmt(sub.grace_until)}</dd>
              </>
            ) : null}
            {sub.ended_at !== null ? (
              <>
                <dt>Ended</dt>
                <dd>{fmt(sub.ended_at)}</dd>
              </>
            ) : null}
          </>
        ) : null}
        <dt>Usage this period</dt>
        <dd data-testid="tenant-sign-usage">{a.subscribed ? `${a.used} of ${a.limit} envelopes (renews ${fmt(a.period_end)})` : '—'}</dd>
        <dt>Online billing</dt>
        <dd>{data.billing_available ? 'Configured' : 'Not configured'}</dd>
      </dl>
      <h3 className="pw-page__title" style={{ fontSize: '1.05rem' }}>
        Recent billing events
      </h3>
      {data.billing_events.length === 0 ? (
        <p className="pw-audit__meta">None.</p>
      ) : (
        <ul className="pw-audit" data-testid="tenant-sign-events">
          {data.billing_events.map((e, i) => (
            <li key={`${e.received_at}-${i}`} className="pw-audit__item">
              <div className="pw-audit__head">
                <span>{e.event_type}</span>
                <span className="pw-audit__meta">{fmt(e.received_at)}</span>
              </div>
              <div className="pw-audit__detail">
                {e.outcome}
                {e.detail !== null ? <span className="pw-audit__meta"> · {e.detail}</span> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
