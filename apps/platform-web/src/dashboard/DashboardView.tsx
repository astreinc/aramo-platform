import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, hasScope, useToast, type Session } from '@aramo/fe-foundation';

import {
  EmptyState,
  PLATFORM_PERMISSIONS as P,
  Pill,
  Skeleton,
  SkeletonPanel,
  TENANT_STATUS_PILL,
  daysAgo,
  formatClock,
  formatDate,
  formatRelative,
  formatTimestamp,
  tenantStatusPill,
} from '../components';
import { platformApi, type PlatformDashboard, type PlatformDashboardActivityRow } from '../platform-api';
import { reasonLabel } from '../tenants/lifecycle-reasons';
import { actorLabel, eventLabel } from '../tenants/tenant-labels';
import { ownerInviteErrorCopy } from '../tenants/tenant-errors';
import { WithSession } from '../tenants/with-session';

import '../tenants/tenants.css';
import './dashboard.css';

// PLATFORM-UX-1 F-3 (handoff §5; directive R-19) — the operator dashboard over
// GET /platform/dashboard: status tiles that open the filtered tenant list, the
// onboarding funnel (PROVISIONED oldest first) with the owner-invite action, and
// the recent lifecycle activity with human labels. Counts, ages, statuses and
// events only — no rating of any tenant. Each panel owns its loading and error
// state; one read feeds all three, so a failed read errors every panel.

const STATUS_ORDER = Object.keys(TENANT_STATUS_PILL);

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: PlatformDashboard; at: Date };

export function DashboardView({ session }: { readonly session?: Session } = {}) {
  return <WithSession session={session}>{(s) => <Dashboard session={s} />}</WithSession>;
}

function Dashboard({ session }: { readonly session: Session }) {
  const navigate = useNavigate();
  const toast = useToast();
  const canProvision = hasScope(session, P.tenantProvision);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [sending, setSending] = useState<string | null>(null);

  const fetchDashboard = useCallback(async (): Promise<void> => {
    setLoad({ status: 'loading' });
    try {
      const data = await platformApi.getDashboard();
      setLoad({ status: 'ready', data, at: new Date() });
    } catch {
      setLoad({ status: 'error' });
    }
  }, []);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  const sendInvite = async (tenantId: string, name: string): Promise<void> => {
    setSending(tenantId);
    try {
      await platformApi.resendOwnerInvite(tenantId);
      toast.show(`Owner invite sent to ${name}.`);
      void fetchDashboard();
    } catch (e) {
      toast.show(ownerInviteErrorCopy(e));
    } finally {
      setSending(null);
    }
  };

  const data = load.status === 'ready' ? load.data : null;
  const counts = new Map((data?.status_counts ?? []).map((c) => [c.status, c.count]));
  const activityValid = data !== null && Array.isArray(data.recent_activity);
  const funnelValid = data !== null && Array.isArray(data.onboarding);

  return (
    <div className="pw-page">
      <div className="pt-head pt-head--22">
        <div>
          <h1 className="pt-h1">Dashboard</h1>
          <p className="pt-intro">
            Tenant counts, onboarding and recent lifecycle activity. The Aramo Platform tenant is excluded.
          </p>
        </div>
        <div className="pt-head__actions">
          {load.status === 'ready' ? (
            <span className="pd-refreshed">
              Refreshed <span className="pt-mono">{formatClock(load.at)}</span>
            </span>
          ) : null}
          <Button unstyled className="pw-btn pw-btn--secondary pw-btn--34" onClick={() => void fetchDashboard()}>
            Refresh
          </Button>
        </div>
      </div>

      {load.status === 'error' ? (
        <div role="alert" className="pw-alert pw-alert--error pt-panel-alert pd-tiles-alert">
          <span>
            <b>Couldn’t load tenant counts.</b>
          </span>
          <TryAgain onClick={() => void fetchDashboard()} />
        </div>
      ) : (
        <section aria-label="Tenant status counts" className="pd-tiles">
          {STATUS_ORDER.map((status) => {
            const pill = tenantStatusPill(status);
            return (
              <Button
                key={status}
                unstyled
                className="pd-tile"
                aria-label={`View ${pill.label} tenants`}
                onClick={() => navigate(`/tenants?status=${status}`)}
              >
                <Pill tone={pill.tone}>{pill.label}</Pill>
                {data === null ? (
                  <Skeleton width={48} height={30} radius={6} />
                ) : (
                  <span className="pd-tile__count">{counts.get(status) ?? 0}</span>
                )}
                <span className="pd-tile__more">View tenants →</span>
              </Button>
            );
          })}
        </section>
      )}

      <div className="pd-panels">
        <section className="pt-card" aria-labelledby="pd-funnel-title">
          <div className="pt-card__head">
            <h2 id="pd-funnel-title" className="pt-card__title">
              Onboarding funnel
            </h2>
            <p className="pt-card__sub">Provisioned tenants waiting for their owner&apos;s first sign-in, oldest first.</p>
          </div>
          {load.status === 'loading' ? <SkeletonPanel lines={['100%', '80%', '90%']} /> : null}
          {load.status === 'error' || (data !== null && !funnelValid) ? (
            <div role="alert" className="pw-alert pw-alert--error pt-panel-alert">
              <span>
                <b>Couldn’t load the onboarding funnel.</b>
                {data !== null ? ' The other panels are unaffected.' : null}
              </span>
              <TryAgain onClick={() => void fetchDashboard()} />
            </div>
          ) : null}
          {funnelValid && data.onboarding.length === 0 ? (
            <EmptyState title="No tenants waiting" body="Every provisioned tenant's owner has signed in." />
          ) : null}
          {funnelValid && data.onboarding.length > 0 ? (
            <div className="pt-scroll">
              <table className="pt-table pt-min560">
                <thead>
                  <tr>
                    <th className="pt-th pt-th--first">Tenant</th>
                    <th className="pt-th">Provisioned</th>
                    <th className="pt-th pt-th--right">Waiting</th>
                    <th className="pt-th">Owner invite</th>
                    <th className="pt-th pt-th--last">
                      <span className="pw-sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.onboarding.slice(0, 10).map((f) => (
                    <tr key={f.tenant_id}>
                      <td className="pt-td pt-td--first">
                        <Link className="pt-strong" to={`/tenants/${f.tenant_id}`}>
                          {f.name}
                        </Link>
                      </td>
                      <td className="pt-td pt-td--13 pt-nowrap">{formatDate(f.created_at)}</td>
                      <td className="pt-td pt-td--13 pt-nowrap pt-right pt-strong">{daysAgo(f.created_at) ?? 0} d</td>
                      <td className="pt-td">
                        {f.invited ? <Pill tone="info">Invited</Pill> : <Pill tone="warn">Not yet invited</Pill>}
                      </td>
                      <td className="pt-td pt-td--last pt-right">
                        {canProvision ? (
                          <Button
                            unstyled
                            className="pw-btn pw-btn--secondary pw-btn--30"
                            disabled={sending === f.tenant_id}
                            aria-busy={sending === f.tenant_id || undefined}
                            onClick={() => void sendInvite(f.tenant_id, f.name)}
                          >
                            {f.invited ? 'Resend invite' : 'Send invite'}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>

        <section className="pt-card" aria-labelledby="pd-activity-title">
          <div className="pt-card__head">
            <h2 id="pd-activity-title" className="pt-card__title">
              Recent lifecycle activity
            </h2>
            <p className="pt-card__sub">Last 15 tenant lifecycle events.</p>
          </div>
          {load.status === 'loading' ? <SkeletonPanel lines={['100%', '70%', '85%']} /> : null}
          {load.status === 'error' || (data !== null && !activityValid) ? (
            <div role="alert" className="pw-alert pw-alert--error pt-panel-alert">
              <span>
                <b>Couldn’t load recent activity.</b>
                {data !== null ? ' The other panels are unaffected.' : null}
              </span>
              <TryAgain onClick={() => void fetchDashboard()} />
            </div>
          ) : null}
          {activityValid && data.recent_activity.length === 0 ? <EmptyState body="No lifecycle events yet." /> : null}
          {activityValid && data.recent_activity.length > 0 ? (
            <ul className="pd-activity">
              {data.recent_activity.slice(0, 15).map((e, i) => (
                <ActivityRow key={`${e.event_type}-${e.created_at}-${i}`} e={e} />
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ActivityRow({ e }: { readonly e: PlatformDashboardActivityRow }) {
  const ts = formatTimestamp(e.created_at);
  return (
    <li className="pd-activity__row">
      <span className="pd-activity__what">
        <b className="pt-strong">{eventLabel(e.event_type)}</b>
        {' · '}
        {e.tenant_id !== null ? (
          <Link to={`/tenants/${e.tenant_id}?tab=lifecycle`}>{e.tenant_name ?? e.tenant_id}</Link>
        ) : (
          (e.tenant_name ?? 'Unknown tenant')
        )}
      </span>
      <span className="pd-activity__rel" title={ts}>
        {formatRelative(e.created_at)}
      </span>
      <span className="pd-activity__why">
        {e.reason_code ? reasonLabel(e.reason_code) : 'No reason code'} · {actorLabel(e.actor_type, e.event_type)}
      </span>
      <span className="pd-activity__ts">{ts}</span>
    </li>
  );
}

function TryAgain({ onClick }: { readonly onClick: () => void }) {
  return (
    <Button unstyled className="pw-btn pw-btn--secondary pw-btn--30 pt-panel-alert__action" onClick={onClick}>
      Try again
    </Button>
  );
}
