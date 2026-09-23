import { forwardRef, type ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  // G1 (Aramo-UI-HotFix-Console-Defect-Register-v1_0-LOCKED) — render a semantic
  // <button> carrying ONLY the caller's className, with NO `tc-button` base or
  // variant/size classes. This lets a context-styled raw button (e.g. ats-web's
  // `rc-*` classes) migrate to the standard component WITHOUT imposing
  // fe-foundation button styling on top of it — a faithful, appearance-preserving
  // conversion (visual standardization of such buttons is a separate concern). When
  // `unstyled`, `variant`/`size` are ignored.
  unstyled?: boolean;
}

const variantClass: Record<ButtonVariant, string> = {
  primary: 'tc-button--primary',
  secondary: 'tc-button--secondary',
  ghost: 'tc-button--ghost',
};

const sizeClass: Record<ButtonSize, string> = {
  sm: 'tc-button--sm',
  md: '',
  lg: 'tc-button--lg',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', unstyled = false, type = 'button', className, ...rest },
  ref,
) {
  const classes = unstyled
    ? className
    : ['tc-button', variantClass[variant], sizeClass[size], className].filter(Boolean).join(' ');
  return <button ref={ref} type={type} className={classes} {...rest} />;
});
Button.displayName = 'Button';
