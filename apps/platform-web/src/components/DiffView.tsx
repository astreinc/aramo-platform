import type { ReactNode } from 'react';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the diff view (handoff §9 Proposals): existing rows plain,
// the proposed row prefixed "+" in the success tint at 700. Colour is never the
// only cue (handoff §15): every changed row carries a +/−/~ sign plus hidden
// text.

export type DiffKind = 'same' | 'added' | 'removed' | 'changed';

export interface DiffRow {
  readonly key: string;
  readonly kind: DiffKind;
  readonly text: ReactNode;
  /** The right-hand qualifier (alias type, relationship type). */
  readonly sub?: ReactNode;
}

export interface DiffViewProps {
  readonly rows: readonly DiffRow[];
  /** The list's accessible name. */
  readonly label?: string;
}

const SIGN: Readonly<Record<DiffKind, string>> = { same: ' ', added: '+', removed: '−', changed: '~' };
const SR: Readonly<Record<DiffKind, string>> = { same: '', added: 'Added: ', removed: 'Removed: ', changed: 'Changed: ' };

export function DiffView({ rows, label = 'Changes' }: DiffViewProps) {
  return (
    <ul className="pw-diff" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} className={`pw-diff__row pw-diff__row--${r.kind}`} data-kind={r.kind}>
          <span className="pw-diff__sign" aria-hidden="true">
            {SIGN[r.kind]}
          </span>
          <span>
            {SR[r.kind] ? <span className="pw-sr-only">{SR[r.kind]}</span> : null}
            {r.text}
          </span>
          <span className="pw-diff__sub">{r.sub}</span>
        </li>
      ))}
    </ul>
  );
}
