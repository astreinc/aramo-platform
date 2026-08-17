import {
  Fragment,
  cloneElement,
  isValidElement,
  useId,
  type ReactElement,
  type ReactNode,
} from 'react';

interface FormFieldProps {
  label?: ReactNode;
  helper?: ReactNode;
  error?: ReactNode;
  /** T10-B3/F-020 — visible (glyph, not colour-alone) + `aria-required`. */
  required?: boolean;
  inline?: boolean;
  children: ReactNode;
}

type ControlProps = {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-required'?: boolean;
};

// T10-B3/F-036 (S1) — accessible field semantics WITHOUT forcing consumers to
// wire ARIA by hand (point 7). For a single valid element child (native
// input/select/textarea or a prop-spreading control such as the Radix-based
// Switch/Combobox) we MERGE — never clobber — id / aria-describedby /
// aria-invalid / aria-required, and render a real <label htmlFor>. Fragments,
// arrays, and non-element children fall back to label-by-proximity (no worse
// than the previous behaviour), so composability is preserved.
export function FormField({
  label,
  helper,
  error,
  required = false,
  inline = false,
  children,
}: FormFieldProps) {
  const autoId = useId();
  const hasError = error !== undefined;
  const hasHelper = helper !== undefined;

  const cloneable =
    isValidElement(children) && (children as ReactElement).type !== Fragment;
  const child = cloneable ? (children as ReactElement<ControlProps>) : null;

  // Use the child's own id when it has one (so the label points at it);
  // otherwise inject a stable generated id.
  const fieldId = child?.props.id ?? autoId;
  const errorId = `${autoId}-error`;
  const helperId = `${autoId}-helper`;
  const describedById = hasError ? errorId : hasHelper ? helperId : undefined;

  let control: ReactNode = children;
  if (child !== null) {
    const existingDescribed = child.props['aria-describedby'];
    const mergedDescribed =
      [existingDescribed, describedById].filter(Boolean).join(' ') || undefined;
    control = cloneElement(child, {
      id: fieldId,
      'aria-describedby': mergedDescribed,
      'aria-invalid': hasError ? true : child.props['aria-invalid'],
      'aria-required': required ? true : child.props['aria-required'],
    });
  }

  const classes = ['tc-form-field', inline ? 'tc-form-field--inline' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      {label !== undefined && (
        <label className="tc-label" htmlFor={fieldId}>
          {label}
          {required ? (
            <span className="tc-required" aria-hidden="true">
              {' '}
              *
            </span>
          ) : null}
        </label>
      )}
      <div>{control}</div>
      {hasError ? (
        <span id={errorId} className="tc-helper tc-helper--error" role="alert">
          {error}
        </span>
      ) : hasHelper ? (
        <span id={helperId} className="tc-helper">
          {helper}
        </span>
      ) : null}
    </div>
  );
}
