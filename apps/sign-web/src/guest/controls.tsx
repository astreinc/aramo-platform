import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

// The signer app's native controls, in ONE place. sign-web is the isolated
// external-signer SPA (scope:sign, DOC-4 R-4-2) with no design-system
// dependency by design: a recipient may have no Aramo account, and the page
// must not pull in the authenticated product shell. Each raw element below is
// a genuine native need (G1 escape hatch), styled by index.css (storyboard 9a).

type Variant = 'primary' | 'secondary' | 'quiet' | 'danger';

export function Btn({ variant = 'primary', className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; children: ReactNode }) {
  // eslint-disable-next-line no-restricted-syntax -- isolated signer SPA native control (scope:sign, no design-system dep).
  return <button type="button" className={`sg-btn sg-btn--${variant}${className ? ` ${className}` : ''}`} {...rest}>{children}</button>;
}

export function TextIn(props: InputHTMLAttributes<HTMLInputElement>) {
  // eslint-disable-next-line no-restricted-syntax -- isolated signer SPA native control (scope:sign, no design-system dep).
  return <input className="sg-input" {...props} />;
}

export function CheckIn(props: InputHTMLAttributes<HTMLInputElement>) {
  // eslint-disable-next-line no-restricted-syntax -- isolated signer SPA native control (scope:sign, no design-system dep).
  return <input type="checkbox" className="sg-check" {...props} />;
}

export function TextBox(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  // eslint-disable-next-line no-restricted-syntax -- isolated signer SPA native control (scope:sign, no design-system dep).
  return <textarea className="sg-input sg-input--area" {...props} />;
}

// FIELD-PARITY-1 P3 T-4 — a DROPDOWN field's choices (the browser's own list: keyboard, screen
// reader and mobile picker for free).
export function SelectIn({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  // eslint-disable-next-line no-restricted-syntax -- isolated signer SPA native control (scope:sign, no design-system dep).
  return <select className="sg-input sg-select" {...props}>{children}</select>;
}
