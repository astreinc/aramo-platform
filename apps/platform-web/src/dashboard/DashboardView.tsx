import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  DataTable,
  InlineAlert,
  KpiCard,
  type TableColumn,
} from '@aramo/fe-foundation';

import {
  platformApi,
  type PlatformDashboard,
  type PlatformDashboardOnboardingRow,
} from '../platform-api';
import { StatusBadge } from '../tenants/status';

import './dashboard.css';

// Inc-3 PR-3.8 (Workstream C) — the operator dashboard, the platform console's
// default screen. Three panels over GET /platform/dashboard: lifecycle status
// counts (KpiCard tiles, badge colors matching the tenant list), the onboarding
// funnel (aged PROVISIONED tenants + the not-yet-invited distinction), and the
// recent tenant.* activity feed (deep-linking into each tenant's audit tab).
// R10: counts, ages, statuses, and events only — no health metric, no composite
// index, nothing resembling a numeric rating of a tenant. Empty states are
// honest — a healthy small estate shows small numbers, not fake density.

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

// Age in whole days from an ISO timestamp to now. Rendered as the onboarding
// "how long has this tenant been waiting" signal (an age, not a rating).
function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const days = Math.max(0, Math.floor(ms / 86_400_000));
  if (days === 0) return 'today';
  if (days === 1) return '1 day';
  return `${days} days`;
}

function InvitedBadge({ invited }: { readonly invited: boolean }) {
  return (
    <span
      className="pw-badge"
      style={{
        display: 'inline-block',
        padding: '2px 9px',
        borderRadius: '999px',
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: invited ? 'var(--ok-tint)' : 'var(--warn-tint)',
        color: invited ? 'var(--ok)' : 'var(--warn)',
      }}
    >
      {invited ? 'Invited' : 'Not yet invited'}
    </span>
  );
}

const ONBOARDING_COLUMNS: ReadonlyArray<
  TableColumn<PlatformDashboardOnboardingRow>
> = [
  {
    key: 'name',
    header: 'Tenant',
    render: (t) => (
      <Link className="rc-link-strong" to={`/tenants/${t.tenant_id}`}>
        <span className="rc-ent__nm">{t.name}</span>
      </Link>
    ),
  },
  { key: 'created_at', header: 'Provisioned', render: (t) => fmtDate(t.created_at) },
  { key: 'age', header: 'Waiting', render: (t) => ageLabel(t.created_at) },
  {
    key: 'invited',
    header: 'Owner invite',
    render: (t) => <InvitedBadge invited={t.invited} />,
  },
];

export function DashboardView() {
  const [data, setData] = useState<PlatformDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await platformApi.getDashboard();
      setData(res);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'Failed to load the dashboard.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="pw-page">
        <InlineAlert variant="error">{error}</InlineAlert>
      </div>
    );
  }
  if (!data) {
    return <div className="pw-page">Loading…</div>;
  }

  return (
    <div className="pw-page pw-dashboard">
      <div className="pw-page__head">
        <h1 className="pw-page__title">Dashboard</h1>
      </div>

      {/* Status counts — one KpiCard per lifecycle status, badge-colored label. */}
      <section aria-label="Tenant status counts" className="pw-kpis">
        {data.status_counts.map((c) => (
          <KpiCard
            key={c.status}
            label={<StatusBadge status={c.status} />}
            value={c.count}
          />
        ))}
      </section>

      <div className="pw-dashboard__grid">
        {/* Onboarding funnel. */}
        <section className="pw-panel" aria-label="Onboarding funnel">
          <h2 className="pw-panel__title">Onboarding funnel</h2>
          <p className="pw-panel__sub">
            Provisioned tenants awaiting activation, oldest first.
          </p>
          <DataTable
            columns={ONBOARDING_COLUMNS}
            rows={data.onboarding}
            rowKey={(t) => t.tenant_id}
            emptyMessage={
              loading ? 'Loading…' : 'No tenants are waiting to onboard.'
            }
          />
        </section>

        {/* Recent lifecycle activity. */}
        <section className="pw-panel" aria-label="Recent activity">
          <h2 className="pw-panel__title">Recent activity</h2>
          <p className="pw-panel__sub">
            The latest tenant lifecycle events across the estate.
          </p>
          {data.recent_activity.length === 0 ? (
            <p className="pw-audit__meta">No recent lifecycle activity.</p>
          ) : (
            <ul className="pw-audit">
              {data.recent_activity.map((a, i) => (
                <li
                  className="pw-audit__item"
                  key={`${a.event_type}-${a.created_at}-${i}`}
                >
                  <div className="pw-audit__head">
                    <span>{a.event_type}</span>
                    <span className="pw-audit__meta">
                      {fmtDateTime(a.created_at)}
                    </span>
                  </div>
                  <div className="pw-audit__detail">
                    {a.tenant_id !== null ? (
                      <Link
                        className="rc-link-strong"
                        to={`/tenants/${a.tenant_id}?tab=lifecycle`}
                      >
                        {a.tenant_name ?? a.tenant_id}
                      </Link>
                    ) : (
                      (a.tenant_name ?? '—')
                    )}
                    {a.reason_code ? (
                      <span className="pw-audit__meta"> · {a.reason_code}</span>
                    ) : null}
                    <span className="pw-audit__meta"> · {a.actor_type}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
