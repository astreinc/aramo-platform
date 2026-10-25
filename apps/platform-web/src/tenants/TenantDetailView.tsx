import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ApiError, Button, hasScope, useToast, type Session } from '@aramo/fe-foundation';

import {
  COMMERCIAL_PERMISSIONS as CP,
  EmptyState,
  LifecycleActionMenu,
  PLATFORM_PERMISSIONS as P,
  Pill,
  SkeletonPanel,
  Timeline,
  ViewOnlyNote,
  formatDateRelative,
  permissionLabel,
  tenantStatusPill,
} from '../components';
import {
  platformApi,
  type PlatformAuditEvent,
  type PlatformTenantDetail,
  type PlatformTenantSign,
} from '../platform-api';
import { useEntityCrumb } from '../shell/crumbs';
import { TenantCommercialPanel } from '../commercial/subscriptions/TenantCommercialPanel';

import { LifecycleDialog } from './LifecycleDialog';
import { LIFECYCLE_ACTIONS, allowedActions, type LifecycleActionKey } from './lifecycle-reasons';
import { TenantDomainPanel } from './TenantDomainPanel';
import { TenantPeoplePanel } from './TenantPeoplePanel';
import { TenantSignPanel } from './TenantSignPanel';
import { ownerInviteErrorCopy } from './tenant-errors';
import { capabilityLabel, kindLabel, providerLabel, timelineFrom } from './tenant-labels';

import './tenants.css';

// PLATFORM-UX-1 F-5 (handoff §6.3, §7; directive R-12, R-13, R-15; amendment
// 4, 12, 13) — the tenant detail. Header: name, status pill, kind badge, the
// sign-in host (slug, B-1b), the tenant ID with Copy, and the Lifecycle actions
// menu limited to the transitions allowed from the current status. Tabs ride
// `?tab=overview|lifecycle|sign|domain|people`. Domain is hidden without
// platform:tenant:lifecycle:manage (its reads need it too); every other missing
// permission shows a view-only note, never a silently missing control.
// CCP-B3 (CCP-UI v1.0 handoff §2 "Overview · Lifecycle · Sign · Commercial (NEW, after Sign) ·
// Domain · People") — the Commercial tab, shown only with platform:subscription:read (its read's
// scope): never to super_admin or catalog_manager (TD-B4-3: RBAC preserved, no scope added).

export type TenantTab = 'overview' | 'lifecycle' | 'sign' | 'commercial' | 'domain' | 'people';

const TAB_LABEL: Readonly<Record<TenantTab, string>> = {
  overview: 'Overview',
  lifecycle: 'Lifecycle & audit',
  sign: 'Aramo Sign',
  commercial: 'Commercial',
  domain: 'Domain',
  people: 'People',
};

/** The tabs this operator sees (amendment 13: Domain needs lifecycle:manage; CCP-B3: Commercial needs subscription:read). */
export function visibleTabs(canLifecycle: boolean, canCommercial = false): TenantTab[] {
  return (['overview', 'lifecycle', 'sign', 'commercial', 'domain', 'people'] as const).filter(
    (t) => (t !== 'domain' || canLifecycle) && (t !== 'commercial' || canCommercial),
  );
}

/** `?tab=` → a visible tab; anything else falls back to Overview. */
export function resolveTab(param: string | null, tabs: readonly TenantTab[]): TenantTab {
  return tabs.find((t) => t === param) ?? 'overview';
}

type Loaded<T> = { status: 'loading' } | { status: 'error'; notFound?: boolean } | { status: 'ready'; value: T };

export function TenantDetailView({ session }: { readonly session: Session }) {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const canLifecycle = hasScope(session, P.tenantLifecycleManage);
  const canProvision = hasScope(session, P.tenantProvision);
  const canCommercial = hasScope(session, CP.subscriptionRead);

  const [tenant, setTenant] = useState<Loaded<PlatformTenantDetail>>({ status: 'loading' });
  const [audit, setAudit] = useState<Loaded<PlatformAuditEvent[]>>({ status: 'loading' });
  const [sign, setSign] = useState<Loaded<PlatformTenantSign>>({ status: 'loading' });
  const [dialog, setDialog] = useState<LifecycleActionKey | null>(null);
  const [sending, setSending] = useState(false);
  const tabRefs = useRef<Partial<Record<TenantTab, HTMLButtonElement | null>>>({});

  const loadTenant = useCallback(async (): Promise<void> => {
    try {
      const res = await platformApi.getTenant(id);
      setTenant({ status: 'ready', value: res.tenant });
    } catch (e) {
      setTenant({ status: 'error', notFound: e instanceof ApiError && e.status === 404 });
    }
  }, [id]);

  const loadAudit = useCallback(async (): Promise<void> => {
    try {
      const res = await platformApi.getTenantAudit(id);
      setAudit({ status: 'ready', value: res.events });
    } catch {
      setAudit({ status: 'error' });
    }
  }, [id]);

  const loadSign = useCallback(async (): Promise<void> => {
    setSign({ status: 'loading' });
    try {
      setSign({ status: 'ready', value: await platformApi.getTenantSign(id) });
    } catch {
      setSign({ status: 'error' });
    }
  }, [id]);

  useEffect(() => {
    setTenant({ status: 'loading' });
    setAudit({ status: 'loading' });
    void loadTenant();
    void loadAudit();
    void loadSign();
  }, [loadTenant, loadAudit, loadSign]);

  const t = tenant.status === 'ready' ? tenant.value : null;
  useEntityCrumb(t?.name ?? null);

  const tabs = visibleTabs(canLifecycle, canCommercial);
  const tab = resolveTab(params.get('tab'), tabs);
  const selectTab = (next: TenantTab): void => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  };
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = tabs.indexOf(tab);
    let next: TenantTab | undefined;
    if (e.key === 'ArrowRight') next = tabs[(at + 1) % tabs.length];
    else if (e.key === 'ArrowLeft') next = tabs[(at - 1 + tabs.length) % tabs.length];
    else if (e.key === 'Home') next = tabs[0];
    else if (e.key === 'End') next = tabs[tabs.length - 1];
    if (next !== undefined) {
      e.preventDefault();
      selectTab(next);
      tabRefs.current[next]?.focus();
    }
  };

  if (tenant.status === 'error') {
    return (
      <div className="pw-page">
        <section className="pt-card pt-w900">
          {tenant.notFound ? (
            <EmptyState title="Tenant not found" body="This tenant doesn’t exist, or its ID is mistyped." />
          ) : (
            <div role="alert" className="pw-alert pw-alert--error pt-panel-alert">
              <span>
                <b>Couldn’t load this tenant.</b>
              </span>
              <Button
                unstyled
                className="pw-btn pw-btn--secondary pw-btn--30 pt-panel-alert__action"
                onClick={() => {
                  setTenant({ status: 'loading' });
                  void loadTenant();
                }}
              >
                Try again
              </Button>
            </div>
          )}
        </section>
      </div>
    );
  }
  if (t === null) {
    return (
      <div className="pw-page" aria-busy="true">
        <SkeletonPanel lines={[240, 320]} label="Loading tenant…" />
      </div>
    );
  }

  const status = tenantStatusPill(t.status);
  const acts = allowedActions(t.status);
  const host = t.slug ? `${t.slug}.aramo.ai` : null;
  const events = audit.status === 'ready' ? audit.value : [];
  const invited = events.some((e) => e.event_type === 'tenant.owner_invite.sent');
  const provisioned = t.status === 'PROVISIONED';
  const menuActions = acts.map((a) => ({
    key: a,
    label: LIFECYCLE_ACTIONS[a].label,
    description: LIFECYCLE_ACTIONS[a].description,
    tone: LIFECYCLE_ACTIONS[a].tone === 'danger' ? ('danger' as const) : ('normal' as const),
  }));

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(t.id);
      toast.show('Tenant ID copied.');
    } catch {
      toast.show('Couldn’t copy the tenant ID.');
    }
  };

  const sendOwnerInvite = async (): Promise<void> => {
    setSending(true);
    try {
      await platformApi.resendOwnerInvite(t.id);
      toast.show(`Owner invite sent to ${t.name}.`);
    } catch (e) {
      toast.show(ownerInviteErrorCopy(e));
    } finally {
      setSending(false);
      void loadAudit();
      void loadTenant();
    }
  };

  const capabilities = sign.status === 'ready' ? sign.value.capabilities.map(capabilityLabel).join(', ') || 'None' : null;
  const overviewRows: readonly (readonly [string, string, boolean?])[] = [
    ['Tenant ID', t.id, true],
    ['Name', t.name],
    ['Kind', kindLabel(t.kind)],
    ['Status', status.label],
    ['Home sign-in provider', providerLabel(t.identity_provider)],
    ['Active', t.is_active ? 'Yes' : 'No'],
    ['Created', formatDateRelative(t.created_at)],
    ['Updated', formatDateRelative(t.updated_at)],
    ['Capabilities', capabilities ?? (sign.status === 'error' ? 'Couldn’t load capabilities' : 'Loading…')],
  ];

  return (
    <div className="pw-page">
      <div className="pt-dhead">
        <div className="pt-dhead__main">
          <div className="pt-dhead__row">
            <h1 className="pt-h1">{t.name}</h1>
            <Pill tone={status.tone}>{status.label}</Pill>
            <span className="pt-kind">{kindLabel(t.kind)}</span>
          </div>
          <div className="pt-dhead__meta">
            {host !== null ? <span className="pt-mono">{host}</span> : <span>No sign-in address</span>}
            <span className="pt-idrow">
              <span className="pt-mono">{t.id}</span>
              <Button unstyled className="pt-copy" aria-label="Copy tenant ID" onClick={() => void copyId()}>
                Copy
              </Button>
            </span>
          </div>
        </div>
        <div>
          {canLifecycle && acts.length > 0 ? (
            <LifecycleActionMenu
              actions={menuActions}
              onSelect={(k) => setDialog(k as LifecycleActionKey)}
              footnote={provisioned ? 'Becomes Active automatically when the owner first signs in.' : undefined}
            />
          ) : null}
          {t.status === 'CLOSED' ? (
            <span className="pt-closed-note">Closed is terminal. No further lifecycle actions.</span>
          ) : null}
        </div>
      </div>
      {!canLifecycle ? (
        <div className="pt-viewonly-wrap">
          <ViewOnlyNote
            subject="this tenant"
            needs="Lifecycle and domain changes need"
            permission={permissionLabel(P.tenantLifecycleManage)}
          />
        </div>
      ) : null}

      <div role="tablist" aria-label="Tenant sections" className="pt-tabs" onKeyDown={onTabKey}>
        {tabs.map((k) => (
          <Button
            key={k}
            ref={(el) => {
              tabRefs.current[k] = el;
            }}
            unstyled
            role="tab"
            id={`pt-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`pt-panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            className={tab === k ? 'pt-tab pt-tab--on' : 'pt-tab'}
            onClick={() => selectTab(k)}
          >
            {TAB_LABEL[k]}
          </Button>
        ))}
      </div>

      <div role="tabpanel" id={`pt-panel-${tab}`} aria-labelledby={`pt-tab-${tab}`}>
        {tab === 'overview' ? (
          <>
            {provisioned ? (
              <div className="pt-callout">
                <span className="pt-callout__text">
                  <b>{invited ? 'Invited' : 'Not yet invited'}.</b>{' '}
                  {invited
                    ? 'Owner invite sent. The tenant becomes Active automatically when the owner first signs in.'
                    : 'The owner hasn’t been invited yet. The tenant stays Provisioned until the owner signs in.'}
                </span>
                {canProvision ? (
                  <Button
                    unstyled
                    className="pw-btn pw-btn--normal pw-btn--34"
                    disabled={sending || audit.status !== 'ready'}
                    aria-busy={sending || undefined}
                    onClick={() => void sendOwnerInvite()}
                  >
                    {invited ? 'Resend owner invite' : 'Send owner invite'}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <section className="pt-card pt-w900" aria-label="Tenant details">
              <dl className="pt-ov">
                {overviewRows.map(([k, v, mono]) => (
                  <div key={k} className="pt-ov__row">
                    <dt className="pt-ov__k">{k}</dt>
                    <dd className={mono ? 'pt-ov__v pt-ov__v--mono' : 'pt-ov__v'}>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          </>
        ) : null}

        {tab === 'lifecycle' ? (
          <>
            {canLifecycle && acts.length > 0 ? (
              <div className="pt-actrow">
                {acts.map((a) => (
                  <Button
                    key={a}
                    unstyled
                    className={`pw-btn pw-btn--secondary pw-btn--34${LIFECYCLE_ACTIONS[a].tone === 'danger' ? ' pt-actbtn--danger' : ''}`}
                    onClick={() => setDialog(a)}
                  >
                    {LIFECYCLE_ACTIONS[a].label}…
                  </Button>
                ))}
              </div>
            ) : null}
            <section className="pt-card pt-w900" aria-labelledby="pt-timeline-title">
              <div className="pt-card__head pt-card__head--14">
                <h2 id="pt-timeline-title" className="pt-card__title">
                  Timeline
                </h2>
                <span className="pt-card__sub">Tenant lifecycle events, newest first.</span>
              </div>
              {audit.status === 'loading' ? <SkeletonPanel lines={['100%', '70%', '85%']} /> : null}
              {audit.status === 'error' ? (
                <div role="alert" className="pw-alert pw-alert--error pt-panel-alert">
                  <span>
                    <b>Couldn’t load the timeline.</b> The other tabs are unaffected.
                  </span>
                  <Button
                    unstyled
                    className="pw-btn pw-btn--secondary pw-btn--30 pt-panel-alert__action"
                    onClick={() => {
                      setAudit({ status: 'loading' });
                      void loadAudit();
                    }}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
              {audit.status === 'ready' && events.length === 0 ? <EmptyState body="No lifecycle events yet." /> : null}
              {audit.status === 'ready' && events.length > 0 ? (
                <div className="pt-tl-wrap">
                  <Timeline events={timelineFrom(events)} />
                </div>
              ) : null}
            </section>
          </>
        ) : null}

        {tab === 'sign' ? (
          <TenantSignPanel
            data={sign.status === 'ready' ? sign.value : null}
            failed={sign.status === 'error'}
            onRetry={() => void loadSign()}
          />
        ) : null}

        {tab === 'commercial' && canCommercial ? (
          <TenantCommercialPanel session={session} tenantId={t.id} tenantName={t.name} sign={sign.status === 'ready' ? sign.value : null} />
        ) : null}

        {tab === 'domain' && canLifecycle ? <TenantDomainPanel tenantId={t.id} tenantName={t.name} kind={t.kind} /> : null}

        {tab === 'people' ? (
          <TenantPeoplePanel tenantId={t.id} host={host ?? 'Aramo'} canInvite={canProvision} />
        ) : null}
      </div>

      <LifecycleDialog
        action={dialog}
        tenantId={t.id}
        tenantName={t.name}
        status={t.status}
        onClose={() => setDialog(null)}
        onStale={() => {
          void loadTenant();
          void loadAudit();
        }}
        onDone={(res) => {
          setDialog(null);
          toast.show(`${t.name} is now ${tenantStatusPill(res.to).label.toLowerCase()}.`);
          void loadTenant();
          void loadAudit();
        }}
      />
    </div>
  );
}
