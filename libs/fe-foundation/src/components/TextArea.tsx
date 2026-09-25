import { forwardRef, type TextareaHTMLAttributes } from 'react';

// G1 — the standard multi-line text control (`.tc-textarea`): full-width,
// vertical-resize, token-styled. forwardRef so it composes as a FormField child.
// `unstyled` keeps only the caller's className (mirrors Button.unstyled) so an
// application-owned class migrates without layering foundation styling. The
// native <textarea> is guard-permitted ONLY inside this lib.
export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  unstyled?: boolean;
};

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { rows = 4, unstyled = false, className, ...rest },
  ref,
) {
  const classes = unstyled ? className : ['tc-textarea', className].filter(Boolean).join(' ');
  return <textarea ref={ref} rows={rows} className={classes} {...rest} />;
});
TextArea.displayName = 'TextArea';
