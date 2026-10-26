import type { ReactNode } from 'react';

import './platform-components.css';
import './ccp-components.css';

// CCP-B1 — the eligibility verdict (CCP-UI v1.0 handoff §3.1, §5.2 items 7–8; §6 NEW
// `EligibilityVerdict`):
//   EligibilityVerdict  "Your eligibility": a green box when the caller can sign
//                       the current step, otherwise a grey box "You can't approve:
//                       {label}" with the why line;
//   RosterVerdicts      "Who can sign the {step} step": every other admin's verdict
//                       (✓ Can sign, or the refusal label), or a designed empty line
//                       when the roster is not available.
// The verdict is the engine's (CCP-A3 checkApprovalEligibility, read through the
// route); this component only shows it.

export interface EligibilityVerdictProps {
  readonly ok: boolean;
  /** "You can sign the Finance step" / the refusal label ("You already approved a step"). */
  readonly label: string;
  readonly why: ReactNode;
}

export function EligibilityVerdict({ ok, label, why }: EligibilityVerdictProps) {
  return (
    <div className={ok ? 'pw-verdict pw-verdict--ok' : 'pw-verdict'} data-testid="eligibility-verdict" data-ok={ok ? 'true' : 'false'}>
      <div className="pw-verdict__caps">Your eligibility</div>
      <div className="pw-verdict__label">
        <span aria-hidden="true">{ok ? '✓' : '—'}</span> {ok ? label : `You can’t approve: ${label}`}
      </div>
      <div className="pw-verdict__why">{why}</div>
    </div>
  );
}

export interface RosterVerdict {
  readonly key: string;
  readonly name: string;
  readonly roles: string;
  readonly ok: boolean;
  /** "Can sign" or the refusal label. */
  readonly label: string;
}

export interface RosterVerdictsProps {
  /** The step name ("Finance"). */
  readonly step: string;
  /** null = the roster is not available (designed empty line). */
  readonly entries: readonly RosterVerdict[] | null;
  /** The empty line. */
  readonly emptyText: ReactNode;
}

export function RosterVerdicts({ step, entries, emptyText }: RosterVerdictsProps) {
  return (
    <div className="pw-roster">
      <div className="pw-ccp-caps">Who can sign the {step} step</div>
      <div className="pw-roster__box">
        {entries === null || entries.length === 0 ? (
          <div className="pw-roster__empty" data-testid="roster-empty">
            {emptyText}
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.key} className="pw-roster__row">
              <span className={e.ok ? 'pw-roster__mark pw-roster__mark--ok' : 'pw-roster__mark'} aria-hidden="true">
                {e.ok ? '✓' : '·'}
              </span>
              <span className="pw-roster__name">{e.name}</span>
              <span className="pw-roster__roles">{e.roles}</span>
              <span className={e.ok ? 'pw-roster__label pw-roster__label--ok' : 'pw-roster__label'}>{e.label}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
