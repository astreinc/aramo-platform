import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  ApiError,
  Button,
  InlineAlert,
  Tabs,
  hasScope,
  useToast,
  type Session,
  type TabItem,
} from '@aramo/fe-foundation';

import {
  platformApi,
  type PlatformAuditEvent,
  type PlatformTenantDetail,
} from '../platform-api';

import { StatusBadge } from './status';
import { LifecycleDialog, type LifecycleAction } from './LifecycleDialog';

const LIFECYCLE_SCOPE = 'platform:tenant:lifecycle:manage';

// The transitions the operator may start from each status (mirrors the service's
// transition table; server-side is authoritative — these just gate button
// visibility).
const ACTIONS_BY_STATUS: Record<string, LifecycleAction[]> = {
  PROVISIONED: ['close'],
  ACTIVE: ['suspend', 'offboarding'],
  SUSPENDED: ['reactivate', 'offboarding'],
  OFFBOARDING: ['close'],
  CLOSED: [],
};

const ACTION_LABEL: Record<LifecycleAction, string> = {
  suspend: 'Suspend',
  reactivate: 'Reactivate',
  offboarding: 'Start offboarding',
  close: 'Close',
};

function fmt(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function auditSummary(e: PlatformAuditEvent): string {
  const p = e.event_payload as {
    before?: { status?: string };
    after?: { status?: string };
    reason?: { code?: string | null; text?: string | null };
  };
  const parts: string[] = [];
  if (p.before?.status && p.after?.status) {
    parts.push(`${p.before.status} → ${p.after.status}`);
  }
  if (p.reason?.code) parts.push(`reason: ${p.reason.code}`);
  if (typeof e.event_payload['reason'] === 'string') {
    parts.push(`reason: ${e.event_payload['reason'] as string}`);
  }
  return parts.join(' · ');
}

export function TenantDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams();
  const toast = useToast();
  const [tenant, setTenant] = useState<PlatformTenantDetail | null>(null);
  const [events, setEvents] = useState<PlatformAuditEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<LifecycleAction | null>(null);
  const canManage = hasScope(session, LIFECYCLE_SCOPE);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [t, a] = await Promise.all([
        platformApi.getTenant(id),
        platformApi.getTenantAudit(id),
      ]);
      setTenant(t.tenant);
      setEvents(a.events);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load tenant.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const resend = async (): Promise<void> => {
    try {
      await platformApi.resendOwnerInvite(id);
      toast.show('Owner invite re-sent.');
    } catch (e) {
      const reason =
        e instanceof ApiError
          ? (e.details?.['reason'] as string | undefined)
          : undefined;
      toast.show(
        e instanceof ApiError
          ? `Resend failed: ${e.message}${reason ? ` (${reason})` : ''}`
          : 'Resend failed.',
      );
      void load(); // state may have changed underneath (422-aware)
    }
  };

  if (error) return <div className="pw-page"><InlineAlert variant="error">{error}</InlineAlert></div>;
  if (!tenant) return <div className="pw-page">Loading…</div>;

  const actions = ACTIONS_BY_STATUS[tenant.status] ?? [];

  const overview = (
    <dl className="pw-facts">
      <dt>Tenant ID</dt>
      <dd className="mono">{tenant.id}</dd>
      <dt>Name</dt>
      <dd>{tenant.name}</dd>
      <dt>Status</dt>
      <dd><StatusBadge status={tenant.status} /></dd>
      <dt>Home realm (IdP)</dt>
      <dd>{tenant.identity_provider ?? '— (chooser)'}</dd>
      <dt>Active</dt>
      <dd>{tenant.is_active ? 'yes' : 'no'}</dd>
      <dt>Created</dt>
      <dd>{fmt(tenant.created_at)}</dd>
      <dt>Updated</dt>
      <dd>{fmt(tenant.updated_at)}</dd>
    </dl>
  );

  const lifecycle = (
    <div>
      <div className="pw-actions">
        {canManage ? (
          actions.map((a) => (
            <Button key={a} variant="secondary" onClick={() => setDialog(a)}>
              {ACTION_LABEL[a]}
            </Button>
          ))
        ) : (
          <span className="pw-audit__meta">
            Read-only (lifecycle:manage scope required to act).
          </span>
        )}
        {tenant.status === 'PROVISIONED' ? (
          <Button variant="ghost" onClick={() => void resend()}>
            Resend owner invite
          </Button>
        ) : null}
      </div>

      <h3 className="pw-page__title" style={{ fontSize: '1.05rem' }}>
        Audit timeline
      </h3>
      {events.length === 0 ? (
        <p className="pw-audit__meta">No lifecycle events yet.</p>
      ) : (
        <ul className="pw-audit">
          {events.map((e, i) => (
            <li className="pw-audit__item" key={`${e.event_type}-${e.created_at}-${i}`}>
              <div className="pw-audit__head">
                <span>{e.event_type}</span>
                <span className="pw-audit__meta">{fmt(e.created_at)}</span>
              </div>
              <div className="pw-audit__detail">
                {auditSummary(e) || '—'}
                <span className="pw-audit__meta">
                  {' '}
                  · {e.actor_type}
                  {e.actor_id ? ` ${e.actor_id.slice(0, 8)}` : ''}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const tabs: TabItem[] = [
    { id: 'overview', label: 'Overview', content: overview },
    { id: 'lifecycle', label: 'Lifecycle & Audit', content: lifecycle },
  ];

  return (
    <div className="pw-page">
      <div className="pw-page__head">
        <h1 className="pw-page__title">{tenant.name}</h1>
        <StatusBadge status={tenant.status} />
      </div>
      <Tabs items={tabs} ariaLabel="Tenant detail" />

      {dialog ? (
        <LifecycleDialog
          action={dialog}
          tenantId={id}
          open={dialog !== null}
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          onDone={() => void load()}
        />
      ) : null}
    </div>
  );
}
