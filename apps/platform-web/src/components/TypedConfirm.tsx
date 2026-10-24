import { useId } from 'react';
import { Input } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — confirm by typing (handoff §9 Platform admins): a 1px
// terracotta mono input; the dialog's commit stays disabled until the typed
// value matches exactly (trimmed, case-insensitive, as the design does).

export interface TypedConfirmProps {
  /** The visible label ("Type the email address to confirm"). */
  readonly label: string;
  /** The value the operator must type. */
  readonly expected: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** True when `value` matches `expected` (trimmed, case-insensitive). */
export function typedConfirmMatches(value: string, expected: string): boolean {
  const want = expected.trim().toLowerCase();
  return want.length > 0 && value.trim().toLowerCase() === want;
}

export function TypedConfirm({ label, expected, value, onChange }: TypedConfirmProps) {
  const id = useId();
  return (
    <div className="pw-field">
      <label className="pw-field__label" htmlFor={id}>
        {label}
      </label>
      <Input
        id={id}
        unstyled
        className="pw-input pw-input--typed"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-expect`}
      />
      <span id={`${id}-expect`} className="pw-sr-only">
        Type {expected} to confirm.
      </span>
    </div>
  );
}
