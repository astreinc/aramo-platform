import type { ReactNode } from 'react';
import { Button, InlineAlert } from '@aramo/fe-foundation';

// T10-B2 (F-016/F-013/F-017/F-022) — the app-local shared UX-state atoms.
// These converge the many bespoke loading paragraphs, `rc-empty` variants, and
// hand-rolled error banners onto one accessible, safe presentation. They live
// in ats-web/src/ui (application presentation), NOT fe-foundation, which is
// domain-neutral — reuse never justifies moving Aramo product presentation into
// the shared lib.
//
// Copy is caller-supplied so domain meaning is preserved (a shared shell is not
// shared wording). Error copy MUST already be product-safe (a governed mapper
// or `safeErrorMessage`); ErrorState renders it verbatim through InlineAlert.

// ── Loading ────────────────────────────────────────────────────────────────
// Accessible status line (role="status" announces politely). Replaces the
// bespoke "Loading X…" paragraphs. Concise default; optional context label.
export function LoadingState({
  label = 'Loading…',
}: {
  readonly label?: ReactNode;
}) {
  return (
    <p className="rc-state rc-state--loading" role="status" data-testid="loading-state">
      {label}
    </p>
  );
}

// ── Empty ──────────────────────────────────────────────────────────────────
// Reusable empty presentation. `message` is domain-specific (no records vs no
// results vs no activity vs no configured source). `action` is an OPTIONAL seam
// for an ALREADY-authorized action — never an invented CTA, never permission
// advertising.
export function EmptyState({
  title,
  message,
  action,
}: {
  readonly title?: ReactNode;
  readonly message: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="rc-state rc-state--empty" data-testid="empty-state">
      {title !== undefined ? <p className="rc-state__title">{title}</p> : null}
      <p className="rc-state__msg">{message}</p>
      {action !== undefined ? (
        <div className="rc-state__action">{action}</div>
      ) : null}
    </div>
  );
}

// ── Error ──────────────────────────────────────────────────────────────────
// Safe visible error through the canonical InlineAlert (role="alert"), with an
// OPTIONAL retry that re-issues an existing idempotent read (never a mutation).
// `message` must already be product-safe. When `onRetry` is provided the retry
// control disables itself while `retrying` to avoid duplicate concurrent reads.
export function ErrorState({
  message,
  onRetry,
  retrying = false,
  retryLabel = 'Try again',
}: {
  readonly message: ReactNode;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
  readonly retryLabel?: ReactNode;
}) {
  return (
    <div className="rc-state rc-state--error" data-testid="error-state">
      <InlineAlert variant="error">{message}</InlineAlert>
      {onRetry !== undefined ? (
        <div className="rc-state__action">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onRetry}
            disabled={retrying}
            data-testid="error-retry"
          >
            {retrying ? 'Retrying…' : retryLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
