import { forwardRef, type InputHTMLAttributes } from 'react';

// G1 (Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED) — the standard
// single-line text control. Token-styled + full-width by default (`.tc-input`),
// forwardRef so it composes as a Radix/FormField child. `unstyled` renders with
// ONLY the caller's className (no `.tc-input`) so an application-owned class
// (e.g. `rc-input`) migrates to the standard component without layering
// foundation styling — mirrors Button.unstyled. The R2 element guard permits the
// native <input> ONLY inside this lib.
export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  unstyled?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { type = 'text', unstyled = false, className, ...rest },
  ref,
) {
  const classes = unstyled ? className : ['tc-input', className].filter(Boolean).join(' ');
  return <input ref={ref} type={type} className={classes} {...rest} />;
});
Input.displayName = 'Input';
