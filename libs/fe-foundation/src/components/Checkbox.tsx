import { forwardRef, type InputHTMLAttributes } from 'react';

// G1 (A3) — the standard checkbox control. Distinct reusable semantics (a boolean
// toggle) that the text `Input` cannot represent, so it earns a first-class
// primitive. Token-styled (`.tc-checkbox`); `unstyled` keeps only the caller's
// className so an application-owned class (e.g. `rc-attest__box`) migrates without
// layering foundation styling. forwardRef; the native <input type="checkbox"> is
// guard-permitted ONLY inside this lib.
export type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  unstyled?: boolean;
};

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { unstyled = false, className, ...rest },
  ref,
) {
  const classes = unstyled ? className : ['tc-checkbox', className].filter(Boolean).join(' ');
  return <input ref={ref} type="checkbox" className={classes} {...rest} />;
});
Checkbox.displayName = 'Checkbox';
