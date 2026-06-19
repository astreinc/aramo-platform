import { useId, type ReactNode } from 'react';

interface AttestCheckboxProps {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}

// The submittal-gate attestation checkbox: a real <input type="checkbox">
// (keyboard + AA), styled label, checked-state highlight. Controlled — the
// gate owns "all three checked → enable Submit" (deliberate friction). The
// exact attestation TEXT is the caller's (it's locked copy on the gate).
export function AttestCheckbox({
  checked,
  onChange,
  children,
  disabled = false,
}: AttestCheckboxProps) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={`rc-attest${checked ? ' rc-attest--checked' : ''}`}
    >
      <input
        id={id}
        type="checkbox"
        className="rc-attest__box"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="rc-attest__tx">{children}</span>
    </label>
  );
}
