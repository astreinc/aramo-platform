import { Button } from '@aramo/fe-foundation';

import './platform-components.css';

// PLATFORM-UX-1 F-1 — access denied, INSIDE the shell (handoff §3.5, directive
// R-5). It never redirects: it names the signed-in account, the organization
// and the missing permission (plain words + mono code), and offers "Sign in
// with a different account", "Sign out" and — only with platform:tenant:read —
// "Back to dashboard".

export interface AccessDeniedProps {
  /** What can't be opened: "Platform administration" or the page name. */
  readonly what: string;
  /** The explanation line. */
  readonly explanation: string;
  /** Signed in as (mono). */
  readonly email: string;
  /** Organization. */
  readonly organization: string;
  /** The missing permission. */
  readonly permission: { readonly label: string; readonly code: string };
  readonly onSwitchAccount: () => void;
  readonly onSignOut: () => void;
  /** Present only when the operator holds platform:tenant:read. */
  readonly onBackToDashboard?: () => void;
}

export function AccessDenied({
  what,
  explanation,
  email,
  organization,
  permission,
  onSwitchAccount,
  onSignOut,
  onBackToDashboard,
}: AccessDeniedProps) {
  return (
    <div className="pw-denied" data-testid="access-denied">
      <span className="pw-denied__pill">No access</span>
      <h1 className="pw-denied__title">This account can&apos;t open {what}</h1>
      <p className="pw-denied__why">{explanation}</p>
      <dl className="pw-denied__facts">
        <dt>Signed in as</dt>
        <dd className="pw-denied__email">{email}</dd>
        <dt>Organization</dt>
        <dd className="pw-denied__org">{organization}</dd>
        <dt>Missing</dt>
        <dd>
          <b>{permission.label}</b> <span className="pw-denied__code">{permission.code}</span>
        </dd>
      </dl>
      <div className="pw-denied__actions">
        <Button unstyled className="pw-btn pw-btn--normal" onClick={onSwitchAccount}>
          Sign in with a different account
        </Button>
        <Button unstyled className="pw-btn pw-btn--secondary" onClick={onSignOut}>
          Sign out
        </Button>
        {onBackToDashboard ? (
          <Button unstyled className="pw-btn pw-btn--link" onClick={onBackToDashboard}>
            Back to dashboard
          </Button>
        ) : null}
      </div>
      <p className="pw-denied__foot">
        Platform administration needs an Aramo staff account. If you were signed in to a tenant app in another
        tab, that session may have been reused here.
      </p>
    </div>
  );
}
