import type { ReactNode } from 'react';

import './platform-components.css';
import './ccp-components.css';

// CCP-B1 — the approval chain (CCP-UI v1.0 handoff §6 "Approval chain list + chain
// progress inline", NEW `ApprovalChain`):
//   ApprovalChain  the drawer list — one row per step: a 22px badge (✓ or the step
//                  number), "Finance · Finance admin", and who signed / Waiting /
//                  Not started / Not signed (handoff §5.2 item 6);
//   ChainProgress  the inbox cell — "Finance ✓ › Owner ○", signed in the ok ink
//                  (handoff §5.1 "Chain").
// Colour is never the only cue: ✓ / ○ marks, and hidden "signed" / "not signed".

export type ChainStepState = 'signed' | 'current' | 'idle';

export interface ApprovalChainStep {
  readonly key: string;
  /** "Finance · Finance admin". */
  readonly title: string;
  /** "Signed by … · 2026-10-24 09:00 UTC" / "Waiting" / "Not started" / "Not signed". */
  readonly who: ReactNode;
  readonly state: ChainStepState;
  /** The 1-based step number (shown until the step is signed). */
  readonly number: number;
}

export interface ApprovalChainProps {
  readonly steps: readonly ApprovalChainStep[];
  /** The list's accessible name. Default: "Approval chain". */
  readonly label?: string;
}

export function ApprovalChain({ steps, label = 'Approval chain' }: ApprovalChainProps) {
  return (
    <ol className="pw-chain" aria-label={label}>
      {steps.map((s) => (
        <li key={s.key} className="pw-chain__step">
          <span className={`pw-chain__badge pw-chain__badge--${s.state}`} aria-hidden="true">
            {s.state === 'signed' ? '✓' : s.number}
          </span>
          <b className="pw-chain__title">{s.title}</b>
          <span className="pw-chain__who">{s.who}</span>
        </li>
      ))}
    </ol>
  );
}

export interface ChainProgressProps {
  readonly steps: readonly { readonly label: string; readonly signed: boolean }[];
}

export function ChainProgress({ steps }: ChainProgressProps) {
  return (
    <span className="pw-chainp">
      {steps.map((s, i) => (
        <span key={`${s.label}-${String(i)}`} className="pw-chainp__item">
          <span className={s.signed ? 'pw-chainp__step pw-chainp__step--signed' : 'pw-chainp__step'}>
            {s.label} <span aria-hidden="true">{s.signed ? '✓' : '○'}</span>
            <span className="pw-sr-only">{s.signed ? ' signed' : ' not signed'}</span>
          </span>
          {i < steps.length - 1 ? (
            <span className="pw-chainp__sep" aria-hidden="true">
              ›
            </span>
          ) : null}
        </span>
      ))}
    </span>
  );
}
