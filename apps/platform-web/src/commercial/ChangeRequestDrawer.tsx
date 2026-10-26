import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, useOptionalToast } from '@aramo/fe-foundation';

import {
  ApprovalChain,
  BeforeAfterDiff,
  ConfirmDialog,
  CrStepper,
  DetailDrawer,
  EligibilityVerdict,
  FieldTextArea,
  Pill,
  RosterVerdicts,
  SkeletonPanel,
  Timeline,
  formatTimestamp,
  shortId,
  type ApprovalChainStep,
} from '../components';

import { commercialApi, type ApproveResult, type ChangeRequest, type ChangeRequestDetail } from './commercial-api';
import { loadErrorText, refusalCopy, type RefusalCopy } from './commercial-errors';
import {
  actionLabel,
  approvalWindow,
  chainSummary,
  commercialRoleLabel,
  effectRows,
  isPending,
  nextStep,
  personLabel,
  productLabel,
  stateSteps,
  statePill,
  stepLabel,
  summaryOf,
  timelineOf,
  verdictFor,
  windowHours,
  type Me,
} from './commercial-model';
import './commercial.css';

// CCP-B1 — the change-request drawer (CCP-UI v1.0 handoff §5.2, on DetailDrawer):
// facts, the state stepper, refusal alerts, the effect, reason and evidence, the
// approval chain, the caller's eligibility (the A3 engine's per-step verdict), who
// can sign, the timeline, and the footer actions: Approve / Reject… (disabled unless
// the engine says the caller can sign the current step), Submit for approval and
// Withdraw for the requester. Every action is an A3 route call; nothing here
// changes commercial state on its own (PLATFORM-UX-1 Amendment A1, A1-2).

export interface ChangeRequestDrawerProps {
  readonly id: string;
  readonly me: Me;
  /** Tenant names by id (the existing tenant list); the id shows when unknown. */
  readonly tenantName: (id: string) => string | null;
  /** A detail the inbox already read (shown at once, then refreshed). */
  readonly initial?: ChangeRequestDetail | null;
  readonly onClose: () => void;
  /** The request changed (approved, rejected, submitted, withdrawn): refresh the lists. */
  readonly onChanged: (detail: ChangeRequestDetail | null) => void;
  /** A 409 CCP_NOT_BOOTSTRAPPED refused this request (feeds the bootstrap banner). */
  readonly onBootstrapRefused?: (request: ChangeRequest) => void;
  /** Clock seam (tests, the visual fixture). */
  readonly now?: () => Date;
}

type Busy = 'submit' | 'withdraw' | null;

export function ChangeRequestDrawer({ id, me, tenantName, initial, onClose, onChanged, onBootstrapRefused, now = () => new Date() }: ChangeRequestDrawerProps) {
  const toast = useOptionalToast();
  const [detail, setDetail] = useState<ChangeRequestDetail | null>(initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alert, setAlert] = useState<RefusalCopy | null>(null);
  const [applyNote, setApplyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // After an action the footer changes (Approve / Reject… leave it), so the element
  // that held focus is gone: focus moves to the drawer body (WCAG 2.4.3), never to
  // <body>.
  const bodyRef = useRef<HTMLDivElement>(null);
  const focusBody = (always: boolean): void => {
    window.setTimeout(() => {
      const a = document.activeElement;
      if (always || a === null || a === document.body || !a.isConnected) bodyRef.current?.focus();
    }, 0);
  };

  const load = useCallback(async (): Promise<ChangeRequestDetail | null> => {
    try {
      const d = await commercialApi.getChangeRequest(id);
      setDetail(d);
      setLoadError(null);
      return d;
    } catch (e) {
      setLoadError(loadErrorText(e));
      return null;
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const close = (open: boolean): void => {
    if (!open) onClose();
  };

  if (detail === null) {
    return (
      <DetailDrawer open onOpenChange={close} variant="ccp" title="Change request" subtitle={<span className="pc-dr-id">{id}</span>}>
        {loadError !== null ? (
          <div role="alert" className="pw-alert pw-alert--error">
            {loadError}
          </div>
        ) : (
          <SkeletonPanel label="Loading the change request…" lines={['40%', '85%', '70%']} />
        )}
      </DetailDrawer>
    );
  }

  const r = detail.request;
  const ctx = { meId: me.id, now: now() };
  const pill = statePill(r.state);
  const pending = isPending(r);
  const verdict = verdictFor(detail, ctx);
  const canSign = verdict.code === 'OK';
  const step = nextStep(detail);
  const isRequester = r.requested_by === me.id;
  const lastStep = step !== null && step.step_index === r.required_chain.steps.length - 1;
  const win = approvalWindow(r, ctx.now);
  const hours = windowHours(r);
  const tenant = r.tenant_id === null ? 'Platform-wide' : (tenantName(r.tenant_id) ?? shortId(r.tenant_id));

  const chainSteps: ApprovalChainStep[] = r.required_chain.steps.map((s) => {
    const a = detail.approvals.find((x) => x.step_index === s.step_index);
    const current = pending && step !== null && step.step_index === s.step_index;
    return {
      key: String(s.step_index),
      number: s.step_index + 1,
      title: `${stepLabel(s.role_key)} · ${commercialRoleLabel(s.role_key)}`,
      state: a ? 'signed' : current ? 'current' : 'idle',
      who: a
        ? `Signed by ${personLabel(a.approver_user_id, me)} · ${formatTimestamp(a.created_at)}`
        : !pending
          ? 'Not signed'
          : current
            ? 'Waiting'
            : 'Not started',
    };
  });

  const after = async (fresh: ChangeRequestDetail | null, message: string): Promise<void> => {
    toast.show(message);
    onChanged(fresh);
    focusBody(true);
  };

  const fail = async (e: unknown, act: 'approve' | 'reject' | 'submit' | 'withdraw'): Promise<RefusalCopy> => {
    const copy = refusalCopy(e, detail, ctx, act);
    if (copy.bootstrap) onBootstrapRefused?.(r);
    const fresh = await load();
    onChanged(fresh);
    focusBody(false);
    return copy;
  };

  const doSubmitOrWithdraw = async (act: 'submit' | 'withdraw'): Promise<void> => {
    setBusy(act);
    setAlert(null);
    try {
      if (act === 'submit') await commercialApi.submit(r.id);
      else await commercialApi.withdraw(r.id);
      const fresh = await load();
      await after(fresh, act === 'submit' ? `${shortId(r.id)} submitted for approval.` : `${shortId(r.id)} withdrawn.`);
    } catch (e) {
      setAlert(await fail(e, act));
    } finally {
      setBusy(null);
    }
  };

  const onApproved = async (out: ApproveResult): Promise<void> => {
    const fresh = await load();
    const signed = stepLabel(out.approval.step_role_key);
    if (out.apply) {
      setApplyNote(
        out.apply.applied
          ? { ok: true, text: 'The role change was applied.' }
          : { ok: false, text: `Approved, but the role change wasn’t applied (${out.apply.reason ?? 'refused'}). The request stays Approved.` },
      );
    }
    await after(fresh, out.request.state === 'PENDING_APPROVAL' ? `${signed} step signed. Waiting on the next approver.` : `${shortId(r.id)} approved.`);
  };

  const reason = (verdict.code === 'OK' ? null : `${verdict.label}.`) ?? undefined;
  const footer = (
    <>
      {pending ? (
        <>
          <Button
            unstyled
            className={`pw-btn pw-btn--privileged pc-btn36${canSign ? '' : ' pw-btn--dim'}`}
            disabled={!canSign}
            title={reason}
            onClick={() => setDialog('approve')}
          >
            Approve
          </Button>
          <Button
            unstyled
            className={`pw-btn pw-btn--secondary pc-btn36${canSign ? '' : ' pw-btn--dim'}`}
            disabled={!canSign}
            title={reason}
            onClick={() => setDialog('reject')}
          >
            Reject…
          </Button>
        </>
      ) : null}
      {r.state === 'DRAFT' && isRequester ? (
        <Button unstyled className="pw-btn pw-btn--privileged pc-btn36" disabled={busy !== null} aria-busy={busy === 'submit' || undefined} onClick={() => void doSubmitOrWithdraw('submit')}>
          Submit for approval
        </Button>
      ) : null}
      {(pending || r.state === 'DRAFT') && isRequester ? (
        <Button unstyled className="pw-btn pw-btn--secondary pc-btn36" disabled={busy !== null} aria-busy={busy === 'withdraw' || undefined} onClick={() => void doSubmitOrWithdraw('withdraw')}>
          Withdraw
        </Button>
      ) : null}
      {pending && !canSign ? (
        <span className="pc-dr-foot" data-testid="cr-footnote">
          {verdict.label}.
        </span>
      ) : null}
    </>
  );

  return (
    <DetailDrawer
      open
      onOpenChange={close}
      variant="ccp"
      title={`${actionLabel(r.action_type)} · ${summaryOf(r, me)}`}
      subtitle={
        <>
          <span className="pc-dr-id" title={r.id}>
            {r.id}
          </span>
          <Pill tone={pill.tone}>{pill.label}</Pill>
        </>
      }
      footer={footer}
    >
      <div className="pc-dr" data-testid="cr-drawer" ref={bodyRef} tabIndex={-1}>
        <dl className="pc-dr-facts">
          <dt>Tenant · product</dt>
          <dd>
            {tenant}
            {r.product_key !== null ? ` · ${productLabel(r.product_key)}` : ''}
          </dd>
          <dt>Requested by</dt>
          <dd>{personLabel(r.requested_by, me)}</dd>
          <dt>Created</dt>
          <dd className="pc-mono12">{formatTimestamp(r.created_at)}</dd>
          <dt>Approval window</dt>
          <dd className={`pc-dr-win pc-tone--${win.tone}`}>{win.text}</dd>
          <dt>Policy</dt>
          <dd>
            <span className="pc-mono12" title={r.policy_version_id}>
              {shortId(r.policy_version_id)}
            </span>{' '}
            · chain {chainSummary(r)} (fixed at creation){hours !== null ? ` · ${hours} h window` : ''}
          </dd>
        </dl>
        <CrStepper steps={stateSteps(r.state, r.action_type)} />
        {alert !== null ? (
          <div role="alert" className="pw-alert pw-alert--error" data-testid="cr-refusal">
            <b>{alert.lead}</b> {alert.message} <span className="pc-mono12">({alert.code})</span>
          </div>
        ) : null}
        {applyNote !== null ? (
          <div role="status" className={applyNote.ok ? 'pw-alert pw-alert--success' : 'pw-alert pw-alert--warn'}>
            {applyNote.text}
          </div>
        ) : null}
        <div>
          <div className="pw-ccp-caps">Effect · before → after</div>
          <BeforeAfterDiff rows={effectRows(r, me).map((e, i) => ({ key: String(i), field: e.field, before: e.before, after: e.after }))} />
        </div>
        <dl className="pc-dr-facts">
          <dt>Reason</dt>
          <dd>{r.reason || '—'}</dd>
          <dt>Evidence</dt>
          <dd data-testid="cr-evidence">—</dd>
        </dl>
        <div>
          <div className="pw-ccp-caps">Approval chain</div>
          <ApprovalChain steps={chainSteps} />
        </div>
        {pending ? (
          <>
            <EligibilityVerdict ok={canSign} label={verdict.label} why={verdict.why} />
            <RosterVerdicts
              step={step !== null ? stepLabel(step.role_key) : 'next'}
              entries={null}
              emptyText="The approver list isn’t available here yet. The server checks every approver when they sign."
            />
          </>
        ) : null}
        <div>
          <div className="pw-ccp-caps pc-caps8">Timeline</div>
          <Timeline events={timelineOf(detail, me)} now={ctx.now} />
        </div>
      </div>
      {dialog === 'approve' && step !== null ? (
        <ApproveDialog
          detail={detail}
          me={me}
          lastStep={lastStep}
          onClose={() => setDialog(null)}
          onApproved={(out) => {
            setDialog(null);
            setAlert(null);
            void onApproved(out);
          }}
          onRefused={async (e) => {
            setDialog(null);
            setAlert(await fail(e, 'approve'));
          }}
        />
      ) : null}
      {dialog === 'reject' ? (
        <RejectDialog
          detail={detail}
          ctxNow={ctx.now}
          meId={me.id}
          onClose={() => setDialog(null)}
          onRejected={async () => {
            setDialog(null);
            setAlert(null);
            const fresh = await load();
            await after(fresh, `${shortId(r.id)} rejected.`);
          }}
          onBootstrapRefused={() => onBootstrapRefused?.(r)}
        />
      ) : null}
    </DetailDrawer>
  );
}

// ── dialogs (handoff §5.10; ConfirmDialog from → to + consequence) ──────────

function ApproveDialog({
  detail,
  me,
  lastStep,
  onClose,
  onApproved,
  onRefused,
}: {
  readonly detail: ChangeRequestDetail;
  readonly me: Me;
  readonly lastStep: boolean;
  readonly onClose: () => void;
  readonly onApproved: (out: ApproveResult) => void;
  readonly onRefused: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const r = detail.request;
  const step = nextStep(detail);
  if (step === null) return null;
  const name = stepLabel(step.role_key);
  const following = r.required_chain.steps[step.step_index + 1];
  const roleChange = r.action_type === 'ROLE_GRANT' || r.action_type === 'ROLE_REVOKE';
  const commit = async (): Promise<void> => {
    setBusy(true);
    try {
      onApproved(await commercialApi.approve(r.id, step.step_index));
    } catch (e) {
      onRefused(e);
    }
  };
  return (
    <ConfirmDialog
      open
      ccp
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Approve the ${name} step · ${summaryOf(r, me)}`}
      from={statePill(r.state)}
      to={lastStep || following === undefined ? statePill('APPROVED') : { label: `${stepLabel(following.role_key)} step next`, tone: 'info' }}
      consequence={
        <>
          You sign the {name} step as {commercialRoleLabel(step.role_key)}. Approving records your name and current roles in the audit log.
          {lastStep && roleChange ? ' The role change applies right after the last step is signed.' : ''}
          {lastStep && !roleChange ? ' This is the last step: the request becomes Approved.' : ''}
        </>
      }
      commitLabel="Approve"
      tone="privileged"
      busy={busy}
      onCommit={() => void commit()}
    />
  );
}

function RejectDialog({
  detail,
  ctxNow,
  meId,
  onClose,
  onRejected,
  onBootstrapRefused,
}: {
  readonly detail: ChangeRequestDetail;
  readonly ctxNow: Date;
  readonly meId: string;
  readonly onClose: () => void;
  readonly onRejected: () => void;
  readonly onBootstrapRefused: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RefusalCopy | null>(null);
  const r = detail.request;
  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await commercialApi.reject(r.id, reason.trim());
      onRejected();
    } catch (e) {
      const copy = refusalCopy(e, detail, { meId, now: ctxNow }, 'reject');
      if (copy.bootstrap) onBootstrapRefused();
      setError(copy);
      setBusy(false);
    }
  };
  return (
    <ConfirmDialog
      open
      ccp
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`Reject ${shortId(r.id)}`}
      from={statePill(r.state)}
      to={statePill('REJECTED')}
      consequence="Rejecting ends the request. The requester can make a new one."
      error={
        error !== null ? (
          <>
            <b>{error.lead}</b> {error.message} <span className="pc-mono12">({error.code})</span>
          </>
        ) : null
      }
      commitLabel="Reject request"
      tone="danger"
      canCommit={reason.trim().length > 0}
      busy={busy}
      onCommit={() => void commit()}
    >
      <FieldTextArea label="Reason (required)" value={reason} onChange={setReason} max={2000} helper="Shown to the requester and recorded in audit" />
    </ConfirmDialog>
  );
}
