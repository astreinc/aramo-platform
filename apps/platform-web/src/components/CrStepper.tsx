import './platform-components.css';
import './ccp-components.css';

// CCP-B1 — the change-request state stepper (CCP-UI v1.0 handoff §4 "Stepper (NEW
// CrStepper)", §6): one 28px chip per main state, Draft → Pending approval →
// Approved → Applying → Applied. Done ✓, current ●, not reached ○; a terminal
// state marks the reached chip ✕, dims the later chips to 45% and appends a
// terminal chip ■. Colour is never the only cue (handoff §9): every chip carries
// its mark plus hidden state text, and the current chip has aria-current="step".

export type CrStepMark = 'done' | 'current' | 'todo' | 'failed' | 'terminal';

export interface CrStep {
  readonly label: string;
  readonly mark: CrStepMark;
  /** Dimmed to 45% (a chip after a terminal state). */
  readonly dim?: boolean;
}

export interface CrStepperProps {
  readonly steps: readonly CrStep[];
  /** The list's accessible name. Default: "Request state" (handoff §9). */
  readonly label?: string;
}

const GLYPH: Readonly<Record<CrStepMark, string>> = { done: '✓', current: '●', todo: '○', failed: '✕', terminal: '■' };
const SR: Readonly<Record<CrStepMark, string>> = {
  done: ' (done)',
  current: ' (current)',
  todo: ' (not reached)',
  failed: ' (stopped here)',
  terminal: ' (final state)',
};

export function CrStepper({ steps, label = 'Request state' }: CrStepperProps) {
  return (
    <ol aria-label={label} className="pw-crstep">
      {steps.map((s, i) => (
        <li
          key={`${s.label}-${String(i)}`}
          className={`pw-crstep__chip pw-crstep__chip--${s.mark}${s.dim === true ? ' pw-crstep__chip--dim' : ''}`}
          aria-current={s.mark === 'current' ? 'step' : undefined}
        >
          <span aria-hidden="true">{GLYPH[s.mark]}</span>
          {s.label}
          <span className="pw-sr-only">{SR[s.mark]}</span>
        </li>
      ))}
    </ol>
  );
}
