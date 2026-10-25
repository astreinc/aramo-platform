import { useId, type ReactNode } from 'react';
import { Button, Dialog, Input, TextArea } from '@aramo/fe-foundation';

import { useReturnFocus } from './use-return-focus';
import './support-components.css';

// CCP-B6 (CCP-UI v1.0 handoff §5.10 "Dialog pattern", §5.9 "Support extension dialog") — the
// dialog of the support-extension workflow, on the fe-foundation Dialog (Radix: focus trap, Esc
// closes, focus returns to the opener). Size min(600px, 94vw). Body, in order: fields → preview
// box (role="status": "Within bounds …" green, or "Out of bounds …" amber) → chain preview strip
// → refusal alert (role="alert"). Footer: Cancel · commit (terracotta for the extension, danger
// for a removal), at 45% opacity until the request is complete. It only ever CREATES a request
// (or the bounded exception the server decides): PLATFORM-UX-1 Amendment A1-2. Local to
// platform-web (directive R-3).

export type SupportCommitTone = 'terra' | 'danger' | 'mid';

export interface SupportPreview {
  readonly tone: 'ok' | 'warn';
  readonly title: string;
  readonly lines: readonly string[];
}

export interface SupportChain {
  /** "Below threshold". */
  readonly label: string;
  /** "Finance". */
  readonly steps: readonly string[];
  /** "v1". */
  readonly policy: string;
  /** "72 h". */
  readonly window: string;
}

export interface SupportRequestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly sub: string;
  readonly children?: ReactNode;
  readonly preview?: SupportPreview | null;
  readonly chain?: SupportChain | null;
  readonly alert?: ReactNode | null;
  readonly commitLabel: string;
  readonly tone?: SupportCommitTone;
  readonly canCommit: boolean;
  readonly busy?: boolean;
  readonly onCommit: () => void;
}

export function SupportRequestDialog({
  open,
  onOpenChange,
  title,
  sub,
  children,
  preview,
  chain,
  alert,
  commitLabel,
  tone = 'mid',
  canCommit,
  busy = false,
  onCommit,
}: SupportRequestDialogProps) {
  useReturnFocus(open);
  const enabled = canCommit && !busy;
  const footer = (
    <>
      <Button unstyled className="pw-sxd__btn" onClick={() => onOpenChange(false)}>
        Cancel
      </Button>
      <Button
        unstyled
        className={`pw-sxd__btn pw-sxd__btn--commit pw-sxd__btn--${tone}${enabled ? '' : ' pw-sxd__btn--dim'}`}
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
      <div className="pw-sxd">
        {children}
        {preview ? (
          <div role="status" className={`pw-sxd__preview pw-sxd__preview--${preview.tone}`}>
            <b>{preview.title}</b>
            <ul>
              {preview.lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {chain ? (
          <div className="pw-sxd__chain" data-testid="chain-preview">
            <span className="pw-sxd__chain-lead">Approval chain</span>
            <b>{chain.label}</b>
            <span className="pw-sxd__chain-steps">{chain.steps.join(' → ')}</span>
            <span className="pw-sxd__chain-meta">{`policy ${chain.policy} · ${chain.window} window`}</span>
          </div>
        ) : null}
        {alert ? (
          <div role="alert" className="pw-sxd__alert">
            {alert}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

export interface SupportFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder?: string;
  /** 12px muted line under the control. */
  readonly help?: string;
  readonly kind?: 'number' | 'area';
  readonly min?: number;
  readonly max?: number;
}

/** A dialog field (design `dl.fields`): 13px/600 label, a 160px number input or a 3-row textarea, optional help. */
export function SupportField({ label, value, onChange, placeholder, help, kind = 'area', min, max }: SupportFieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const labelId = `${id}-label`;
  // The design's DOM (a block label wrapping a block caption span, the control and the help
  // span): the control's accessible name is the caption alone (aria-labelledby), the help is
  // its description.
  return (
    <label className="pw-sxd__field" htmlFor={id}>
      <span id={labelId} className="pw-sxd__label">
        {label}
      </span>
      {kind === 'number' ? (
        <Input
          unstyled
          id={id}
          type="number"
          className="pw-sxd__num"
          value={value}
          min={min}
          max={max}
          aria-labelledby={labelId}
          aria-describedby={help ? helpId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <TextArea
          unstyled
          id={id}
          className="pw-sxd__area"
          rows={3}
          value={value}
          placeholder={placeholder}
          aria-labelledby={labelId}
          aria-describedby={help ? helpId : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help ? (
        <span id={helpId} className="pw-sxd__help">
          {help}
        </span>
      ) : null}
    </label>
  );
}
