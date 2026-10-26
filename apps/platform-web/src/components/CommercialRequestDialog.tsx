import { useId, type ReactNode } from 'react';
import { Button, Dialog, Input, TextArea } from '@aramo/fe-foundation';

import { useReturnFocus } from './use-return-focus';
import './commercial-components.css';

// CCP-B2 (CCP handoff §5.10 "Dialog pattern (extends PLATFORM-UX-1 §3.8)") — the dialog every
// commercial action opens to CREATE A CHANGE REQUEST (never to apply a change: PLATFORM-UX-1
// Amendment A1-2). On the fe-foundation Dialog (Radix: focus trap, Esc closes, focus returns to
// the opener). Size min(600px, 94vw). Body, in order: fields → "Before → after" diff → chain
// preview → typed confirmation → refusal alert. Footer: Cancel · commit (terracotta for
// privileged requests, danger for retire/cancel/revoke/end, midnight otherwise), at 45%
// opacity until the caller says the request is complete. Local to platform-web (R-3).

export type CommercialCommitTone = 'terra' | 'danger' | 'mid';

export interface CommercialDiffRow {
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly changed: boolean;
}

export interface CommercialRequestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  /** The consequence line under the title. */
  readonly sub: ReactNode;
  /** The fields (Reason, Evidence …). */
  readonly children?: ReactNode;
  readonly diff?: readonly CommercialDiffRow[];
  /** A ChainPreview. */
  readonly chain?: ReactNode;
  /** Confirm by typing (e.g. "Team v2"). */
  readonly typed?: { readonly token: string; readonly value: string; readonly onChange: (v: string) => void } | null;
  /** The refusal from the last commit (role="alert"). */
  readonly alert?: ReactNode | null;
  readonly commitLabel: string;
  readonly tone?: CommercialCommitTone;
  readonly canCommit: boolean;
  readonly busy?: boolean;
  readonly onCommit: () => void;
  /**
   * CCP-B3 — the design's "Save as draft" (handoff §5.10 footer: Cancel · Save as draft (where
   * offered) · commit). Disabled with the commit's validity; additive (absent = not offered).
   */
  readonly secondary?: { readonly label: string; readonly disabled: boolean; readonly onClick: () => void } | null;
}

/** True when the typed value matches the token exactly (the design compares strictly). */
export function typedTokenMatches(value: string, token: string): boolean {
  return token.length > 0 && value === token;
}

export function CommercialRequestDialog({
  open,
  onOpenChange,
  title,
  sub,
  children,
  diff,
  chain,
  typed,
  alert,
  commitLabel,
  tone = 'mid',
  canCommit,
  busy = false,
  onCommit,
  secondary = null,
}: CommercialRequestDialogProps) {
  useReturnFocus(open);
  const typedId = useId();
  const typedOk = typed === null || typed === undefined || typedTokenMatches(typed.value, typed.token);
  const enabled = canCommit && typedOk && !busy;
  const footer = (
    <>
      <Button unstyled className="pw-crd__btn pw-crd__btn--cancel" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      {secondary ? (
        <Button
          unstyled
          className={`pw-crd__btn${secondary.disabled || busy ? ' pw-crd__btn--dim' : ''}`}
          disabled={secondary.disabled || busy}
          onClick={() => {
            if (!secondary.disabled && !busy) secondary.onClick();
          }}
        >
          {secondary.label}
        </Button>
      ) : null}
      <Button
        unstyled
        className={`pw-crd__btn pw-crd__btn--commit pw-crd__btn--${tone}${enabled ? '' : ' pw-crd__btn--dim'}`}
        disabled={!enabled}
        aria-busy={busy || undefined}
        onClick={() => {
          if (enabled) onCommit();
        }}
      >
        {commitLabel}
      </Button>
    </>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} description={sub} footer={footer}>
      <div className="pw-crd">
        {children}
        {diff && diff.length > 0 ? (
          <div>
            <div className="pw-crd__caps">Before → after</div>
            <div className="pw-crd__diff" role="table" aria-label="Before and after">
              {diff.map((d) => (
                <div key={d.field} role="row" className={`pw-crd__diff-row${d.changed ? ' pw-crd__diff-row--changed' : ''}`}>
                  <span role="cell" className="pw-crd__diff-field">
                    {d.changed ? `~ ${d.field}` : ` ${d.field}`}
                  </span>
                  <span role="cell" className="pw-crd__diff-before">
                    {d.changed ? <span className="pw-sr-only">Before: </span> : null}
                    {d.before}
                  </span>
                  <span role="cell" className="pw-crd__diff-after">
                    {d.changed ? <span className="pw-sr-only">After: </span> : null}
                    {d.after}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {chain}
        {typed ? (
          <label className="pw-crd__field" htmlFor={typedId}>
            <span className="pw-crd__label">
              Type <span className="pw-crd__token">{typed.token}</span> to confirm
            </span>
            <Input unstyled id={typedId} className="pw-crd__typed" value={typed.value} onChange={(e) => typed.onChange(e.target.value)} autoComplete="off" spellCheck={false} />
          </label>
        ) : null}
        {alert ? (
          <div role="alert" className="pw-crd__alert">
            {alert}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export interface RequestFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder: string;
  readonly multiline?: boolean;
}

/** A dialog field: 13px/600 label, a 38px input or a 3-row textarea (design `ev()`). */
export function RequestField({ label, value, onChange, placeholder, multiline = false }: RequestFieldProps) {
  const id = useId();
  return (
    <label className="pw-crd__field" htmlFor={id}>
      <span className="pw-crd__label">{label}</span>
      {multiline ? (
        <TextArea unstyled id={id} className="pw-crd__area" rows={3} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <Input unstyled id={id} className="pw-crd__input" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      )}
    </label>
  );
}
