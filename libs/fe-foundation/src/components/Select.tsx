import { forwardRef, type SelectHTMLAttributes } from 'react';

// G1 — Q-A ratified: a token-styled NATIVE <select> wrapper (`.tc-select`),
// full-width, matching the Input box. `unstyled` keeps only the caller's
// className (mirrors Button.unstyled) so an application-owned class (e.g.
// `rc-select`) migrates without layering foundation styling. forwardRef; the
// native <select> is guard-permitted ONLY inside this lib.
export type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & {
  unstyled?: boolean;
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { unstyled = false, className, ...rest },
  ref,
) {
  const classes = unstyled ? className : ['tc-select', className].filter(Boolean).join(' ');
  return <select ref={ref} className={classes} {...rest} />;
});
Select.displayName = 'Select';
