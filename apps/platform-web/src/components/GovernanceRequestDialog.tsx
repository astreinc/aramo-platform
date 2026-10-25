import { useId, type ReactNode } from 'react';
import { Button, Dialog, Input, TextArea } from '@aramo/fe-foundation';

import { useReturnFocus } from './use-return-focus';
import './governance-components.css';

// CCP-B5 (handoff §5.10 "Dialog pattern", §6 ChainPreview) — the change-request dialog of
// the commercial console, on the fe-foundation Dialog (Radix: focus trap, Esc closes, focus
// returns to the opener). Body, in order: the caller's fields → Before → after diff → chain
// preview strip → the refusal alert. Footer: Cancel · commit. The commit carries the
// request's tone (terracotta for privileged requests, danger for removals, midnight
// otherwise) and sits at 45% until the caller says the request is complete.
//
// Local to platform-web (PLATFORM-UX-1 R-3; no fe-foundation edit). The geometry is scoped to
// dialogs holding `.pw-gd` (governance-components.css), so other dialogs are untouched.

export type GovernanceTone = 'privileged' | 'danger' | 'normal';

export interface ChainPreviewProps {
  /** "Policy change". */
  readonly label: string;
  /** "Finance → Owner". */
  readonly steps: string;
  /** "v1". */
  readonly policy: string;
  /** "72 h". */
  readonly ttl: string;
  /** The chain is not fulfillable by distinct people right now (handoff §3.2). */
  readonly notFulfillable?: boolean;
}

/** The chain preview strip (handoff §5.10). */
export function ChainPreview({
  label,
  steps,
  policy,
  ttl,
  notFulfillable = false,
}: ChainPreviewProps) {
  return (
    <div className="pw-gd-chain" data-testid="chain-preview">
      <span className="pw-gd-chain__lead">Approval chain</span>
      <b>{label}</b>
      <span className="pw-gd-chain__steps">
        {steps}
        {notFulfillable ? ' · not fulfillable yet' : ''}
      </span>
      <span className="pw-gd-chain__policy">
        policy {policy} · {ttl} window
      </span>
    </div>
  );
}

export interface GovernanceRequestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly sub: ReactNode;
  /** The request's own fields, above Reason and Evidence. */
  readonly children?: ReactNode;
  readonly reason: string;
  readonly onReason: (v: string) => void;
  readonly evidence: string;
  readonly onEvidence: (v: string) => void;
  /** Before → after rows: [setting, before, after]. */
  readonly diff: readonly (readonly [string, string, string])[];
  readonly chain: ChainPreviewProps | null;
  /** A refusal that blocks the commit (role="alert"), e.g. the last-owner rule. */
  readonly alert?: string | null;
  /** The error of the last commit (role="alert"). */
  readonly error?: string | null;
  readonly commitLabel: string;
  readonly tone?: GovernanceTone;
  readonly canCommit: boolean;
  readonly busy?: boolean;
  readonly onCommit: () => void;
}

export function GovernanceRequestDialog({
  open,
  onOpenChange,
  title,
  sub,
  children,
  reason,
  onReason,
  evidence,
  onEvidence,
  diff,
  chain,
  alert = null,
  error = null,
  commitLabel,
  tone = 'privileged',
  canCommit,
  busy = false,
  onCommit,
}: GovernanceRequestDialogProps) {
  useReturnFocus(open);
  const reasonId = useId();
  const evidenceId = useId();
  const disabled = !canCommit || busy || (alert ?? null) !== null;
  const footer = (
    <>
      <Button
        unstyled
        className="pw-gd-btn pw-gd-btn--secondary"
        onClick={() => onOpenChange(false)}
      >
        Cancel
      </Button>
      <Button
        unstyled
        className={`pw-gd-btn pw-gd-btn--commit pw-gd-btn--${tone}${disabled ? ' pw-gd-btn--dim' : ''}`}
        disabled={disabled}
        aria-busy={busy || undefined}
        onClick={() => {
          if (!disabled) onCommit();
        }}
      >
        {commitLabel}
      </Button>
    </>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={sub} footer={footer}>
      <div className="pw-gd">
        {children}
        <label className="pw-gd-field" htmlFor={reasonId}>
          <span className="pw-gd-field__label">Reason</span>
          <TextArea
            id={reasonId}
            unstyled
            className="pw-gd-textarea"
            rows={3}
            placeholder="Why this change is needed"
            value={reason}
            onChange={(e) => onReason(e.target.value)}
          />
        </label>
        <label className="pw-gd-field" htmlFor={evidenceId}>
          <span className="pw-gd-field__label">Evidence</span>
          <Input
            id={evidenceId}
            unstyled
            className="pw-gd-input"
            placeholder="Document, ticket or call notes reference"
            value={evidence}
            onChange={(e) => onEvidence(e.target.value)}
          />
        </label>
        {diff.length > 0 ? (
          <div>
            <div className="pw-gd-diff__cap">Before → after</div>
            <div className="pw-gd-diff" role="table" aria-label="Before and after">
              {diff.map(([f, b, a]) => {
                const changed = b !== a;
                return (
                  <div
                    key={f}
                    role="row"
                    className={
                      changed ? 'pw-gd-diff__row pw-gd-diff__row--changed' : 'pw-gd-diff__row'
                    }
                  >
                    <span role="cell" className="pw-gd-diff__field">
                      {changed ? '~ ' : ' '}
                      {f}
                    </span>
                    <span role="cell" className="pw-gd-diff__before">
                      {changed ? <span className="pw-sr-only">Before: </span> : null}
                      {b}
                    </span>
                    <span role="cell" className="pw-gd-diff__after">
                      {changed ? <span className="pw-sr-only">After: </span> : null}
                      {a}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
        {chain !== null ? <ChainPreview {...chain} /> : null}
        {alert !== null ? (
          <div role="alert" className="pw-gd-alert">
            {alert}
          </div>
        ) : null}
        {error !== null ? (
          <div role="alert" className="pw-gd-alert">
            {error}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
