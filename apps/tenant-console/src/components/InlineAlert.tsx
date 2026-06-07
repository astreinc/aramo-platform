import type { ReactNode } from 'react';

type AlertVariant = 'error' | 'success';

interface InlineAlertProps {
  variant?: AlertVariant;
  children: ReactNode;
}

const variantClass: Record<AlertVariant, string> = {
  error: 'tc-alert--error',
  success: 'tc-alert--success',
};

const variantIcon: Record<AlertVariant, string> = {
  error: '!',
  success: '✓',
};

export function InlineAlert({ variant = 'error', children }: InlineAlertProps) {
  return (
    <div
      className={`tc-alert ${variantClass[variant]}`}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      <span aria-hidden="true" className="tc-alert__icon">
        {variantIcon[variant]}
      </span>
      <span className="tc-alert__message">{children}</span>
    </div>
  );
}
