import { useId, type ReactNode } from 'react';
import { Checkbox, Input, Select, TextArea } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the field grammar of the confirm dialog (Platform
// Admin.dc.html dialog fields): a 13px/600 label over a 38px control, a
// textarea with an "n / max" counter, a select, and the terminal-action
// acknowledgement box. All on fe-foundation controls (no raw elements).

interface FieldBase {
  readonly label: ReactNode;
  /** 12.5px muted helper under the control. */
  readonly helper?: ReactNode;
  readonly required?: boolean;
}

function Label({ text, required }: { readonly text: ReactNode; readonly required?: boolean }) {
  return (
    <span className="pw-field__label">
      {text}
      {required ? (
        <>
          {' '}
          <span className="pw-field__req" aria-hidden="true">
            *
          </span>
        </>
      ) : null}
    </span>
  );
}

export interface FieldTextProps extends FieldBase {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly type?: 'text' | 'email' | 'date' | 'datetime-local' | 'number';
  readonly mono?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly maxLength?: number;
}

export function FieldText({
  label,
  helper,
  required,
  value,
  onChange,
  type = 'text',
  mono = false,
  disabled = false,
  placeholder,
  maxLength,
}: FieldTextProps) {
  const id = useId();
  return (
    <div className="pw-field">
      <label className="pw-field__labelwrap" htmlFor={id}>
        <Label text={label} required={required} />
      </label>
      <Input
        id={id}
        unstyled
        type={type}
        className={`pw-input${mono ? ' pw-input--mono' : ''}`}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        required={required}
        aria-describedby={helper ? `${id}-help` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {helper ? (
        <span id={`${id}-help`} className="pw-field__helper">
          {helper}
        </span>
      ) : null}
    </div>
  );
}

export interface FieldTextAreaProps extends FieldBase {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Hard cap; shows the "n / max" counter. */
  readonly max?: number;
  readonly rows?: number;
}

export function FieldTextArea({ label, helper, required, value, onChange, max, rows = 3 }: FieldTextAreaProps) {
  const id = useId();
  return (
    <div className="pw-field">
      <label className="pw-field__labelwrap" htmlFor={id}>
        <Label text={label} required={required} />
      </label>
      <TextArea
        id={id}
        unstyled
        className="pw-textarea"
        rows={rows}
        value={value}
        required={required}
        aria-describedby={helper ? `${id}-help` : undefined}
        onChange={(e) => onChange(max ? e.target.value.slice(0, max) : e.target.value)}
      />
      {max ? (
        <span className="pw-field__count" aria-live="polite">
          {value.length} / {max}
        </span>
      ) : null}
      {helper ? (
        <span id={`${id}-help`} className="pw-field__helper">
          {helper}
        </span>
      ) : null}
    </div>
  );
}

export interface FieldSelectOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

export interface FieldSelectProps extends FieldBase {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly FieldSelectOption[];
}

export function FieldSelect({ label, helper, required, value, onChange, options }: FieldSelectProps) {
  const id = useId();
  return (
    <div className="pw-field">
      <label className="pw-field__labelwrap" htmlFor={id}>
        <Label text={label} required={required} />
      </label>
      <Select
        id={id}
        unstyled
        className="pw-select"
        value={value}
        required={required}
        aria-describedby={helper ? `${id}-help` : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </Select>
      {helper ? (
        <span id={`${id}-help`} className="pw-field__helper">
          {helper}
        </span>
      ) : null}
    </div>
  );
}

export interface FieldAckProps {
  /** The acknowledgement sentence ("I understand closing is terminal…"). */
  readonly label: ReactNode;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}

/** The terminal-action acknowledgement box (danger-tinted). */
export function FieldAck({ label, checked, onChange }: FieldAckProps) {
  return (
    <label className="pw-ack">
      <Checkbox unstyled className="pw-ack__box" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
