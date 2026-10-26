import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, Button, useOptionalToast } from '@aramo/fe-foundation';

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
  WithdrawFailedActivationDialog,
  WithheldAmount,
  applyDeadlineText,
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
  MONETARY_ACTIONS,
  splitEvidence,
  summaryWithheld,
  windowLabel,
  withdrawnAfterFail,
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
import { deadlineOf, policyOf, withdrawActionable, type DeadlineSources } from './deadline';
import './commercial.css';

// CCP-UI-V12 additions (CCP-UI v1.1 AM-3, AM-5, AM-6, AM-8; v1.2 §17.1 D-1, D-4, §17.2; W-3):
// the "Apply window" fact and the Approved chip / timeline event name the apply deadline of the
// request's creation policy ("No apply deadline (policy v{n})" when it declares none); Apply
// ("Apply activation" for a policy) and Retry apply render ONLY when the read says
// `apply_actionable` (requester-only, TD-B2-3), with the requester-only footnotes otherwise;
// Withdraw… on a failed policy activation only when the policy read says `withdraw_actionable`
// (ACC-1); a money row the server withheld renders WithheldAmount; and, for a CREDIT / DISCOUNT /
// REFUND / PAYMENT_RECORD request read without Finance amount access, the reason and evidence are
// "restricted" (`reason_withheld`, R3-W contract) or, for the requester, labelled as their own.
//
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
  /** CCP-UI-V12: the policy versions and the configured near-expiry lead (deadline.ts). */
  readonly sources?: DeadlineSources;
  /** CCP-UI-V12 (W-3): the caller holds platform:billing:amount:read. */
  readonly amountHolder?: boolean;
}

type Busy = 'submit' | 'withdraw' | 'apply' | null;

export const RESTRICTED_FINANCIAL = 'Financial details restricted — Finance access required';
export const YOUR_DETAILS = 'Your request details';
export const FINANCE_NOTES_RESTRICTED = 'Finance notes on this request are restricted';

function applyErrorText(e: unknown): string {
  if (e instanceof ApiError) {
    const ex = e.details?.['explanation'];
    if (typeof ex === 'string' && ex.length > 0) return ex;
    return e.message;
  }
  return 'The request couldn’t be applied. Try again.';
}

export function ChangeRequestDrawer({ id, me, tenantName, initial, onClose, onChanged, onBootstrapRefused, now = () => new Date(), sources, amountHolder = true }: ChangeRequestDrawerProps) {
  const toast = useOptionalToast();
  const [detail, setDetail] = useState<ChangeRequestDetail | null>(initial ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [alert, setAlert] = useState<RefusalCopy | null>(null);
  const [applyNote, setApplyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'withdrawFailed' | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
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
  const dl = sources === undefined ? undefined : deadlineOf(r, sources);
  const pol = sources === undefined ? null : policyOf(r.policy_version_id, sources.policies);
  const win = approvalWindow(r, ctx.now, dl);
  const actionable = detail.apply_actionable === true;
  const canWithdrawFailed = r.state === 'APPLY_FAILED' && r.action_type === 'POLICY_ACTIVATE' && isRequester && withdrawActionable(r.id, sources?.policies ?? null);
  const approvedLabel = dl === undefined ? undefined : applyDeadlineText({ applyBy: dl.applyBy, policyVersion: dl.policyVersion, state: 'APPROVED', variant: 'stepper', now: ctx.now, nearHours: dl.nearHours }).text;
  // W-3 (CCP-R3-W contract): the markers decide. `reason_withheld` (or a REFUND's
  // `payload.evidence_withheld`) → restricted; the requester without amount access sees their own
  // text labelled "Your request details"; `notes_withheld` → the Finance-notes notice.
  const monetary = MONETARY_ACTIONS.includes(r.action_type);
  const restricted = r.reason_withheld !== undefined;
  const evidenceRestricted = restricted || typeof r.payload['evidence_withheld'] === 'string';
  const ownRestricted = monetary && !amountHolder && isRequester && !restricted;
  const notesWithheld = r.notes_withheld !== undefined;
  const { reason: reasonText, evidence: evidenceText } = splitEvidence(r.reason ?? '');
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
    // D-1: the approval toast names who applies, and until when.
    const by = dl?.applyBy ?? null;
    // Until the request's policy version is read, the deadline is unknown: the plain toast.
    const approvedText =
      dl === undefined
        ? `${shortId(r.id)} approved.`
        : by !== null
        ? `${shortId(r.id)} approved. ${personLabel(r.requested_by, me)} can apply it until ${formatTimestamp(by.toISOString())}.`
          : `${shortId(r.id)} approved. ${personLabel(r.requested_by, me)} can apply it (no apply deadline under ${dl.policyVersion !== null ? `policy v${dl.policyVersion}` : 'its policy'}).`;
    await after(fresh, out.request.state === 'PENDING_APPROVAL' ? `${signed} step signed. Waiting on the next approver.` : approvedText);
  };

  const doApply = async (): Promise<void> => {
    setBusy('apply');
    setApplyError(null);
    try {
      await commercialApi.apply(r.id, r.action_type);
      const fresh = await load();
      await after(fresh, `${shortId(r.id)} applied.`);
    } catch (e) {
      setApplyError(applyErrorText(e));
      const fresh = await load();
      onChanged(fresh);
    } finally {
      setBusy(null);
    }
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
      {r.state === 'APPROVED' && actionable ? (
        <Button unstyled className="pw-btn pw-btn--privileged pc-btn36" disabled={busy !== null} aria-busy={busy === 'apply' || undefined} onClick={() => void doApply()}>
          {r.action_type === 'POLICY_ACTIVATE' ? 'Apply activation' : 'Apply'}
        </Button>
      ) : null}
      {r.state === 'APPLY_FAILED' && actionable ? (
        <Button unstyled className="pw-btn pw-btn--normal pc-btn36" disabled={busy !== null} aria-busy={busy === 'apply' || undefined} onClick={() => void doApply()}>
          Retry apply
        </Button>
      ) : null}
      {canWithdrawFailed ? (
        <Button unstyled className="pw-btn pw-btn--danger pc-btn36" disabled={busy !== null} onClick={() => setDialog('withdrawFailed')}>
          Withdraw…
        </Button>
      ) : null}
      {pending && !canSign ? (
        <span className="pc-dr-foot" data-testid="cr-footnote">
          {verdict.label}.
        </span>
      ) : null}
      {r.state === 'APPROVED' && !isRequester ? (
        <span className="pc-dr-foot" data-testid="cr-footnote">
          Only the requester, {personLabel(r.requested_by, me)}, can apply this request.
        </span>
      ) : null}
      {r.state === 'APPLY_FAILED' && !isRequester ? (
        <span className="pc-dr-foot" data-testid="cr-footnote">
          Only the requester, {personLabel(r.requested_by, me)}, can retry.
        </span>
      ) : null}
      {r.state === 'APPLY_EXPIRED' ? (
        <span className="pc-dr-foot" data-testid="cr-footnote">
          The apply window closed. Make a new request to try again.
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
          <dt>{windowLabel(r)}</dt>
          <dd className={`pc-dr-win pc-tone--${win.tone}`}>{win.text}</dd>
          <dt>Policy</dt>
          <dd>
            <span className="pc-mono12" title={r.policy_version_id}>
              {pol !== null ? `v${pol.number}${!pol.active && pol.activeNumber !== null ? ` (active is v${pol.activeNumber})` : ''}` : shortId(r.policy_version_id)}
            </span>{' '}
            · chain {chainSummary(r)} (fixed at creation){hours !== null ? ` · ${hours} h window` : ''}
          </dd>
        </dl>
        <CrStepper steps={stateSteps(r.state, r.action_type, { approvedLabel, afterFail: withdrawnAfterFail(r) })} />
        {alert !== null ? (
          <div role="alert" className="pw-alert pw-alert--error" data-testid="cr-refusal">
            <b>{alert.lead}</b> {alert.message} <span className="pc-mono12">({alert.code})</span>
          </div>
        ) : null}
        {applyError !== null ? (
          <div role="alert" className="pw-alert pw-alert--error" data-testid="cr-apply-error">
            {applyError}
          </div>
        ) : null}
        {applyNote !== null ? (
          <div role="status" className={applyNote.ok ? 'pw-alert pw-alert--success' : 'pw-alert pw-alert--warn'}>
            {applyNote.text}
          </div>
        ) : null}
        <div>
          <div className="pw-ccp-caps">Effect · before → after</div>
          <BeforeAfterDiff rows={effectRows(r, me).map((e, i) => ({ key: String(i), field: e.field, before: e.before, after: e.after, withheld: e.withheld }))} />
          {summaryWithheld(r) ? (
            <div className="pc-row__chip">
              <WithheldAmount reason="FINANCE_SCOPE_REQUIRED" size="cell" />
            </div>
          ) : null}
        </div>
        {ownRestricted ? <div className="pw-ccp-caps">{YOUR_DETAILS}</div> : null}
        <dl className="pc-dr-facts" data-testid="cr-reason-block">
          <dt>Reason</dt>
          <dd>{restricted ? <span className="pc-dr-restricted">{RESTRICTED_FINANCIAL}</span> : reasonText || '—'}</dd>
          <dt>Evidence</dt>
          <dd data-testid="cr-evidence">{evidenceRestricted ? <span className="pc-dr-restricted">{RESTRICTED_FINANCIAL}</span> : evidenceText || '—'}</dd>
        </dl>
        {notesWithheld ? (
          <div className="pw-alert pw-alert--info" role="note" data-testid="cr-finance-notes-restricted">
            {FINANCE_NOTES_RESTRICTED}
          </div>
        ) : null}
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
          <Timeline events={timelineOf(detail, me, dl)} now={ctx.now} />
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
      {dialog === 'withdrawFailed' ? (
        <WithdrawFailedActivationDialog
          open
          onOpenChange={(o) => {
            if (!o) setDialog(null);
          }}
          requestLabel={shortId(r.id)}
          policyVersion={(() => {
            const target = r.payload['policy_version_id'];
            return typeof target === 'string' ? (policyOf(target, sources?.policies ?? null)?.number ?? null) : null;
          })()}
          onWithdraw={async () => {
            try {
              await commercialApi.withdraw(r.id);
              return 'WITHDRAWN';
            } catch (e) {
              const reasonCode = e instanceof ApiError ? e.details?.['reason'] : undefined;
              if (reasonCode === 'already_applied') return 'ALREADY_APPLIED';
              if (reasonCode === 'apply_in_progress') return 'APPLY_IN_PROGRESS';
              throw new Error(applyErrorText(e));
            }
          }}
          onWithdrawn={() => {
            setDialog(null);
            void load().then((fresh) => after(fresh, `${shortId(r.id)} withdrawn. Activating this version again needs a new request.`));
          }}
          onReconciled={() => void load().then((fresh) => onChanged(fresh))}
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
