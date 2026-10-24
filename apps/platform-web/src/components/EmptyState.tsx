import type { ReactNode } from 'react';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — the empty state (handoff §3.6): centred in the card, a
// 600 title, one 13px muted line, and an optional action.

export interface EmptyStateProps {
  /** The 600 title; omit for a single muted line ("No lifecycle events yet."). */
  readonly title?: ReactNode;
  readonly body?: ReactNode;
  /** An action (e.g. a "Clear filters" Button). */
  readonly action?: ReactNode;
  /** md = 36px 20px (panels), lg = 40px 20px (tables). Default: md. */
  readonly size?: 'md' | 'lg';
}

export function EmptyState({ title, body, action, size = 'md' }: EmptyStateProps) {
  return (
    <div className={`pw-empty pw-empty--${size}`}>
      {title !== undefined ? <div className="pw-empty__title">{title}</div> : null}
      {body !== undefined ? (
        <div className={title !== undefined ? 'pw-empty__body' : 'pw-empty__body pw-empty__body--solo'}>{body}</div>
      ) : null}
      {action !== undefined ? <div className="pw-empty__action">{action}</div> : null}
    </div>
  );
}
