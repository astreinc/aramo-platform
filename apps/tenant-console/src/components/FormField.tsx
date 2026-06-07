import type { ReactNode } from 'react';

interface FormFieldProps {
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  inline?: boolean;
  children: ReactNode;
}

export function FormField({
  label,
  helper,
  error,
  inline = false,
  children,
}: FormFieldProps) {
  const classes = ['tc-form-field', inline ? 'tc-form-field--inline' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes}>
      {label !== undefined && <div className="tc-label">{label}</div>}
      <div>{children}</div>
      {error !== undefined ? (
        <span className="tc-helper tc-helper--error">{error}</span>
      ) : helper !== undefined ? (
        <span className="tc-helper">{helper}</span>
      ) : null}
    </div>
  );
}
