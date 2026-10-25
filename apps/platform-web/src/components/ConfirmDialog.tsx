import type { ReactNode } from 'react';
import { Button, Dialog, DialogClose } from '@aramo/fe-foundation';

import { Pill, type PillSpec } from './Pill';
import { useReturnFocus } from './use-return-focus';
import './platform-components.css';

// PLATFORM-UX-1 F-1 — the confirm dialog pattern (handoff §3.8) on the
// fe-foundation Dialog (Radix: focus trap, Esc closes, focus returns to the
// opener). Body, in order: the Change box (from pill → to pill), the
// consequence line, the caller's fields, the error (role="alert"). The commit
// button carries the action's tone and sits at 45% opacity until the caller
// says the required fields are valid.
//
// The platform look is applied by platform-components.css, scoped with :has()
// to dialogs that contain `.pw-cd`, so other fe-foundation dialogs are untouched.

/** normal = midnight · privileged = terracotta with midnight text · danger = terminal. */
export type ConfirmTone = 'normal' | 'privileged' | 'danger';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  /** The Change box: shown when both are given. */
  readonly from?: PillSpec | null;
  readonly to?: PillSpec | null;
  /** The consequence line (13.5px secondary ink). */
  readonly consequence?: ReactNode;
  /** The fields (use the ConfirmFields helpers). */
  readonly children?: ReactNode;
  /** The error from the last commit (role="alert"). */
  readonly error?: ReactNode | null;
  readonly commitLabel: string;
  /** Default: normal. */
  readonly tone?: ConfirmTone;
  /** False keeps commit disabled at 45% opacity. Default: true. */
  readonly canCommit?: boolean;
  /** True while the commit request is in flight. */
  readonly busy?: boolean;
  readonly onCommit: () => void;
  /** 720px instead of 580px (a dialog that holds a diff). */
  readonly wide?: boolean;
  /** CCP-B1: the CCP-UI v1.0 dialog size, min(600px, 94vw), with its 18px title (handoff §5.10). */
  readonly ccp?: boolean;
  /** Default: "Cancel". */
  readonly cancelLabel?: string;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  from,
  to,
  consequence,
  children,
  error,
  commitLabel,
  tone = 'normal',
  canCommit = true,
  busy = false,
  onCommit,
  wide = false,
  ccp = false,
  cancelLabel = 'Cancel',
}: ConfirmDialogProps) {
  useReturnFocus(open);
  const disabled = !canCommit || busy;
  const footer = (
    <>
      <Button unstyled className="pw-btn pw-btn--secondary" onClick={() => onOpenChange(false)}>
        {cancelLabel}
      </Button>
      <Button
        unstyled
        className={`pw-btn pw-btn--${tone}${canCommit ? '' : ' pw-btn--dim'}`}
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
    <Dialog open={open} onOpenChange={onOpenChange} title={title} footer={footer}>
      <div className={`pw-cd${wide ? ' pw-cd--wide' : ''}${ccp ? ' pw-cd--ccp' : ''}`}>
        {from && to ? (
          <div className="pw-cd__change">
            <span className="pw-cd__change-label">Change</span>
            <Pill tone={from.tone} size="lg">
              {from.label}
            </Pill>
            <span className="pw-cd__arrow" aria-hidden="true">
              →
            </span>
            <span className="pw-sr-only"> to </span>
            <Pill tone={to.tone} size="lg" strong>
              {to.label}
            </Pill>
          </div>
        ) : null}
        {consequence ? <p className="pw-cd__consequence">{consequence}</p> : null}
        {children ? <div className="pw-cd__fields">{children}</div> : null}
        {error ? (
          <div role="alert" className="pw-alert pw-alert--error pw-cd__error">
            {error}
          </div>
        ) : null}
        {/* After the content, so focus lands on the first field when the dialog opens. */}
        <DialogClose className="pw-cd__close" aria-label="Close">
          ×
        </DialogClose>
      </div>
    </Dialog>
  );
}
