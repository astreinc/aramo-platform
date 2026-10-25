import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, Button, hasScope, useToast, type Session } from '@aramo/fe-foundation';

import { COMMERCIAL_PERMISSIONS as CP, EmptyState, FieldSelect, Pill, SkeletonPanel } from '../../components';
import { ExceptionOverlay } from '../../components/ExceptionOverlay';
import { useIdentity } from '../../identity/identity';
import { platformApi, type PlatformTenantSummary } from '../../platform-api';

import {
  supportExtensionApi,
  type SupportChangeRequest,
  type SupportChangeRequestDetail,
  type SupportExtension,
  type SupportExtensionList,
  type SupportExtensionOutcome,
} from './support-extension-api';
import {
  approvalsHref,
  breachLine,
  dayLabel,
  openRequestText,
  overlayView,
  roleLabels,
  shortRef,
  sourceBadge,
  statusFact,
} from './support-extension-model';
import { RemoveExtensionDialog, RequestExtensionDialog, refusalText } from './SupportExtensionDialogs';

import './support-extensions.css';

// CCP-B6 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 B6 row: "extensions and escalations";
// CCP-UI v1.0 handoff §5.9 support extension + exception overlay, §5.10 dialogs, §2 view-only) —
// the support workflow, at /commercial/support-extensions?tenant=<uuid>.
//
// The design places this on Tenant › Commercial (B3); until that tab exists the workflow is a
// routed view built from the same pinned elements (the product card, the exception overlay, the
// open-request strip, the actions with their domain reasons, the §5.10 dialogs). Route gate
// `platform:subscription:read` (App.tsx). Inside:
//   • Request support extension…   support_admin (`platform:subscription:support`) only. One POST;
//     in bounds the server applies it as an audited EXCEPTION (zero approvals); a breach escalates
//     to Finance and NEVER applies (the escalated request is approved in the Approvals drawer).
//   • Request removal…              support_admin only: a SUPPORT_EXTENSION change request with
//     operation REMOVE, Finance approves (TD-A8-5).
//   • Apply                         the requester only, on an APPROVED / APPLY_FAILED request whose
//     read says `apply_actionable` (TD-B2-3; A6-R).
//   • Everyone else with the read scope sees it view-only, with the reason inline (§2).
// The console never mutates commercial state directly (PLATFORM-UX-1 Amendment A1-2).

export interface SupportExtensionsViewProps {
  readonly session: Session;
  /** Test seam: the clock. */
  readonly now?: () => Date;
}

type Load<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly message: string } | { readonly status: 'ready'; readonly value: T };

interface TenantState {
  readonly list: SupportExtensionList;
  readonly open: readonly { readonly request: SupportChangeRequest; readonly detail: SupportChangeRequestDetail | null }[];
}

const VIEW_ONLY = 'You can view this tenant’s commercial state. Requests need the Commercial ops role; support extensions need Support admin.';

const INTRO = 'Within the active policy’s bounds, a support extension applies at once as an exception, with zero approvals, and is flagged in audit. Out of bounds it escalates to Finance and applies only after approval.';

function loadError(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return 'Your account can’t read this tenant’s support extensions.';
  return 'Support extensions couldn’t be loaded. Try again.';
}

export function SupportExtensionsView({ session, now = () => new Date() }: SupportExtensionsViewProps) {
  const identity = useIdentity();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tenantId = params.get('tenant') ?? '';
  const canRequest = hasScope(session, CP.subscriptionSupport);
  const canReadRequests = hasScope(session, CP.approvalRead);

  const [tenants, setTenants] = useState<Load<readonly PlatformTenantSummary[]>>({ status: 'loading' });
  const [state, setState] = useState<Load<TenantState> | null>(null);
  const [dialog, setDialog] = useState<{ readonly kind: 'extend' } | { readonly kind: 'remove'; readonly extension: SupportExtension } | null>(null);
  const [notice, setNotice] = useState<{ readonly tone: 'ok' | 'warn' | 'error'; readonly text: string; readonly requestId?: string } | null>(null);
  const [applying, setApplying] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    platformApi.listTenants().then(
      (r) => {
        if (!cancelled) setTenants({ status: 'ready', value: [...r.tenants].sort((a, b) => a.name.localeCompare(b.name)) });
      },
      (err: unknown) => {
        if (!cancelled) setTenants({ status: 'error', message: loadError(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!tenantId) {
      setState(null);
      return;
    }
    setState({ status: 'loading' });
    try {
      const list = await supportExtensionApi.list(tenantId);
      const requests = canReadRequests ? await supportExtensionApi.openRequests(tenantId) : [];
      const open = await Promise.all(
        requests.map(async (request) => ({ request, detail: await supportExtensionApi.detail(request.id).catch(() => null) })),
      );
      setState({ status: 'ready', value: { list, open } });
    } catch (err) {
      setState({ status: 'error', message: loadError(err) });
    }
  }, [tenantId, canReadRequests]);

  useEffect(() => {
    void load();
  }, [load]);

  const tenant = tenants.status === 'ready' ? (tenants.value.find((t) => t.id === tenantId) ?? null) : null;
  const tenantName = tenant?.name ?? tenantId;

  const onExtended = (out: SupportExtensionOutcome): void => {
    setDialog(null);
    if (out.outcome === 'APPLIED') {
      toast.show('Extension applied as an exception — zero approvals, flagged in audit.');
      setNotice(null);
    } else {
      const why = out.decision ? breachLine(out.decision.breaches, out.decision.eligibility, out.decision.clause) : '';
      setNotice({ tone: 'warn', text: `Escalated to Finance — nothing was applied. ${why}`.trim(), requestId: out.request.id });
      toast.show('Submitted for approval. Nothing applies until Finance signs.');
    }
    void load();
  };

  const onRemovalRequested = (r: SupportChangeRequest): void => {
    setDialog(null);
    setNotice({ tone: 'ok', text: 'Removal submitted for approval. The overlay stays until Finance signs and you apply it.', requestId: r.id });
    toast.show('Removal submitted for approval.');
    void load();
  };

  const apply = async (id: string): Promise<void> => {
    setApplying(id);
    try {
      const out = await supportExtensionApi.apply(id);
      toast.show(out.request.state === 'APPLIED' ? 'Change applied.' : `Apply ${out.request.state.toLowerCase().replace('_', ' ')}.`);
      setNotice(null);
    } catch (err) {
      setNotice({ tone: 'error', text: refusalText(err), requestId: id });
    } finally {
      setApplying(null);
      void load();
    }
  };

  const tenantOptions = useMemo(
    () => [
      { value: '', label: 'Choose a tenant' },
      ...(tenants.status === 'ready' ? tenants.value.map((t) => ({ value: t.id, label: t.name })) : []),
    ],
    [tenants],
  );

  return (
    <div className="pw-page sx">
      <div className="sx-head">
        <h1 className="sx-h1">Support extensions</h1>
        <p className="sx-intro">{INTRO}</p>
      </div>

      <div className="sx-pick">
        <FieldSelect
          label="Tenant"
          value={tenantId}
          options={tenantOptions}
          onChange={(v) => {
            setNotice(null);
            setParams(v ? { tenant: v } : {});
          }}
        />
      </div>

      {!canRequest ? (
        // The Tenant › Commercial view-only note, verbatim (.dc.html td.viewOnlyText).
        <div className="sx-viewonly" role="note">
          <b>View only.</b>
          {` ${VIEW_ONLY}`}
        </div>
      ) : null}

      {notice ? (
        <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`sx-notice sx-notice--${notice.tone}`}>
          {notice.text}
          {notice.requestId ? (
            <>
              {' '}
              <Link className="sx-ref" to={approvalsHref(notice.requestId)}>
                {shortRef(notice.requestId)}
              </Link>
            </>
          ) : null}
        </div>
      ) : null}

      {tenants.status === 'error' ? (
        <div role="alert" className="sx-notice sx-notice--error">
          {tenants.message}
        </div>
      ) : null}

      {!tenantId ? (
        <section className="sx-card">
          <EmptyState title="Choose a tenant" body="Its Aramo Sign subscription, support extensions and open requests appear here." />
        </section>
      ) : state === null || state.status === 'loading' ? (
        <section className="sx-card" aria-busy="true">
          <SkeletonPanel lines={['100%', '80%', '90%', '60%']} />
        </section>
      ) : state.status === 'error' ? (
        <section className="sx-card">
          <EmptyState title="Couldn’t load" body={state.message} action={<Button unstyled className="pw-btn pw-btn--secondary pw-btn--34" onClick={() => void load()}>Try again</Button>} />
        </section>
      ) : (
        <TenantCard
          tenantId={tenantId}
          value={state.value}
          canRequest={canRequest}
          meId={session.sub}
          meName={identity.name}
          now={now}
          applying={applying}
          onExtend={() => setDialog({ kind: 'extend' })}
          onRemove={(extension) => setDialog({ kind: 'remove', extension })}
          onApply={(id) => void apply(id)}
        />
      )}

      {dialog?.kind === 'extend' && state?.status === 'ready' && state.value.list.subscriptions[0] ? (
        <RequestExtensionDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          tenantId={tenantId}
          tenantName={tenantName}
          subscription={state.value.list.subscriptions[0]}
          policy={state.value.list.policy}
          prior={state.value.list.extensions}
          actorName={identity.name}
          actorRoles={identity.role ?? roleLabels([])}
          now={now}
          onDone={onExtended}
        />
      ) : null}
      {dialog?.kind === 'remove' && state?.status === 'ready' ? (
        <RemoveExtensionDialog
          open
          onOpenChange={(o) => !o && setDialog(null)}
          tenantId={tenantId}
          extension={dialog.extension}
          policy={state.value.list.policy}
          onDone={onRemovalRequested}
        />
      ) : null}
    </div>
  );
}

interface TenantCardProps {
  readonly tenantId: string;
  readonly value: TenantState;
  readonly canRequest: boolean;
  readonly meId: string;
  readonly meName: string;
  readonly now: () => Date;
  readonly applying: string | null;
  readonly onExtend: () => void;
  readonly onRemove: (e: SupportExtension) => void;
  readonly onApply: (id: string) => void;
}

function TenantCard({ value, canRequest, meId, meName, now, applying, onExtend, onRemove, onApply }: TenantCardProps) {
  const { list, open } = value;
  const sub = list.subscriptions[0] ?? null;
  const at = now();
  const active = list.extensions.filter((e) => e.active === true);
  const earlier = list.extensions.filter((e) => e.active !== true);
  const openRequest = open[0] ?? null;
  const blocked = openRequest !== null;
  const roleWhy = canRequest ? '' : 'Needs the Support admin role.';
  const extendWhy = sub === null ? 'No open subscription.' : '';
  const extendDisabled = !canRequest || blocked || sub === null || list.policy === null;
  const hasException = active.some((e) => e.is_exception);
  const badge = sub ? sourceBadge(sub) : null;
  const fact = sub ? statusFact(sub, at) : null;

  return (
    <>
      <section className="sx-card" aria-label="Aramo Sign">
        <div className="sx-card__head">
          <h2 className="sx-card__title">Aramo Sign</h2>
          {badge ? <span className={`sx-src${badge.stripe ? ' sx-src--stripe' : ''}`}>{badge.label}</span> : null}
          {hasException ? <span className="sx-flag">Extension · exception</span> : null}
        </div>
        <div className="sx-card__body">
          {sub === null ? <div className="sx-muted">No open base subscription.</div> : null}
          {sub !== null && fact !== null ? (
            <div className="sx-facts">
              <div>
                <div className="sx-facts__k">Status</div>
                <div className={`sx-facts__v sx-facts__v--${fact.tone}`}>{fact.label}</div>
                <div className="sx-facts__s">{fact.sub}</div>
              </div>
              <div>
                <div className="sx-facts__k">Current period ends</div>
                <div className="sx-facts__v">{dayLabel(sub.current_period_end)}</div>
                <div className="sx-facts__s">{sub.source === 'SELF_SERVICE' ? 'Self-service, no commitment' : ''}</div>
              </div>
              <div>
                <div className="sx-facts__k">Active extensions</div>
                <div className="sx-facts__v">{active.length}</div>
                <div className="sx-facts__s">{active.length > 0 ? `Sending extended to ${dayLabel(active.map((e) => e.extends_until).sort().at(-1))}` : ''}</div>
              </div>
            </div>
          ) : null}

          {active.map((e) => {
            const v = overlayView(e, { all: list.extensions, policy: list.policy, subscription: sub, meId, meName, now: at });
            return (
              <div key={e.id} className="sx-overlay">
                <ExceptionOverlay
                  exception={v.exception}
                  title={v.title}
                  reference={v.ref}
                  rows={[
                    { label: 'Actor', value: v.actor },
                    { label: 'Roles at the time', value: v.roles },
                    { label: 'Policy clause', value: v.clause },
                    { label: `Uses in ${list.policy?.clause.support_extension_frequency_window_days ?? 90}-day window`, value: v.uses },
                    { label: 'Cumulative days', value: v.cumulative },
                    { label: 'Stripe billing', value: v.billing },
                  ]}
                />
                {canRequest ? (
                  <div className="sx-overlay__actions">
                    <Button
                      unstyled
                      className={`pw-btn pw-btn--30 sx-btn-danger${blocked ? ' pw-btn--dim' : ''}`}
                      disabled={blocked}
                      title={blocked ? 'Another request on this product is open.' : undefined}
                      onClick={() => onRemove(e)}
                    >
                      Request removal…
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}

          {open.map(({ request, detail }) => {
            // TD-B2-3: Apply only for the requester, only when the read says it is actionable.
            const actionable = detail?.apply_actionable === true && request.requested_by === meId && (request.state === 'APPROVED' || request.state === 'APPLY_FAILED');
            return (
              <div key={request.id} className="sx-open">
                <span>
                  Open request{' '}
                  <Link className="sx-open__ref" to={approvalsHref(request.id)}>
                    {shortRef(request.id)}
                  </Link>{' '}
                  · {openRequestText(request)}
                </span>
                {actionable ? (
                  <Button
                    unstyled
                    className={`pw-btn pw-btn--30 pw-btn--normal sx-open__apply${applying === request.id ? ' pw-btn--dim' : ''}`}
                    disabled={applying === request.id}
                    aria-busy={applying === request.id || undefined}
                    onClick={() => onApply(request.id)}
                  >
                    {request.state === 'APPLY_FAILED' ? 'Retry apply' : 'Apply'}
                  </Button>
                ) : null}
              </div>
            );
          })}

          <div className="sx-actions">
            <Button
              unstyled
              className={`pw-btn pw-btn--34 pw-btn--secondary${extendDisabled ? ' pw-btn--dim' : ''}`}
              disabled={extendDisabled}
              title={extendWhy || roleWhy || (blocked ? 'Another request on this product is open.' : undefined)}
              onClick={onExtend}
            >
              Request support extension…
            </Button>
          </div>
          {extendWhy ? (
            <ul className="sx-reasons">
              <li>
                <b>Request support extension:</b> {extendWhy}
              </li>
            </ul>
          ) : null}
        </div>
      </section>

      {earlier.length > 0 ? (
        <section className="sx-card sx-card--table" aria-label="Earlier extensions">
          <div className="sx-card__head">
            <h2 className="sx-card__title">Earlier extensions</h2>
          </div>
          <div className="sx-table-wrap">
            <table className="sx-table">
              <thead>
                <tr>
                  <th scope="col">Extension</th>
                  <th scope="col">Days</th>
                  <th scope="col">Applied</th>
                  <th scope="col">Ended</th>
                </tr>
              </thead>
              <tbody>
                {earlier.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <span className="sx-mono">EXT-{shortRef(e.id)}</span>
                      <Pill tone={e.is_exception ? 'neutral' : 'muted'} size="sm">
                        {e.is_exception ? 'Exception' : 'Approved'}
                      </Pill>
                    </td>
                    <td>{e.days}</td>
                    <td>{dayLabel(e.applied_at)}</td>
                    <td>{e.removed_at ? `Removed ${dayLabel(e.removed_at)}` : `Ran out ${dayLabel(e.extends_until)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
