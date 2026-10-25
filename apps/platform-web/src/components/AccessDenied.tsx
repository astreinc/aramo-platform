import type { ReactNode } from 'react';
import { Button } from '@aramo/fe-foundation';

import './platform-components.css';
import './ccp-components.css';

// PLATFORM-UX-1 F-1 — access denied, INSIDE the shell (handoff §3.5, directive
// R-5). It never redirects: it names the signed-in account, the organization
// and the missing permission (plain words + mono code), and offers "Sign in
// with a different account", "Sign out" and — only with platform:tenant:read —
// "Back to dashboard".
//
// CCP-B1 (CCP-UI v1.0 handoff §2 "Deep links"): the optional `role` ("Current
// role") and `grants` ("Grants access", the roles that open the page, as chips)
// rows, a custom footnote, and the `ccp` variant (the CCP card's type sizes). R-5
// still holds for the CCP card: Sign out and the Missing row stay.

export interface AccessDeniedProps {
  /** What can't be opened: "Platform administration" or the page name. */
  readonly what: string;
  /** The explanation line. */
  readonly explanation: string;
  /** Signed in as (mono). */
  readonly email: string;
  /** Organization. Omit to leave the row out (the CCP card). */
  readonly organization?: string;
  /** The missing permission. */
  readonly permission: { readonly label: string; readonly code: string };
  readonly onSwitchAccount: () => void;
  readonly onSignOut: () => void;
  /** Present only when the operator holds platform:tenant:read. */
  readonly onBackToDashboard?: () => void;
  /** CCP-B1: the signed-in role label ("Super admin"). */
  readonly role?: string | null;
  /** CCP-B1: the roles that grant access, shown as chips. */
  readonly grants?: readonly string[];
  /** CCP-B1: replaces the default footnote. */
  readonly footnote?: ReactNode;
  /** CCP-B1: the CCP-UI v1.0 card (handoff §2). Default: the PLATFORM-UX-1 card. */
  readonly variant?: 'default' | 'ccp';
}

const DEFAULT_FOOT =
  'Platform administration needs an Aramo staff account. If you were signed in to a tenant app in another tab, that session may have been reused here.';

export function AccessDenied({
  what,
  explanation,
  email,
  organization,
  permission,
  onSwitchAccount,
  onSignOut,
  onBackToDashboard,
  role,
  grants,
  footnote,
  variant = 'default',
}: AccessDeniedProps) {
  return (
    <div className={variant === 'ccp' ? 'pw-denied pw-denied--ccp' : 'pw-denied'} data-testid="access-denied">
      <span className="pw-denied__pill">No access</span>
      <h1 className="pw-denied__title">This account can&apos;t open {what}</h1>
      <p className="pw-denied__why">{explanation}</p>
      <dl className="pw-denied__facts">
        <dt>Signed in as</dt>
        <dd className="pw-denied__email">{email}</dd>
        {organization !== undefined ? (
          <>
            <dt>Organization</dt>
            <dd className="pw-denied__org">{organization}</dd>
          </>
        ) : null}
        {role !== undefined ? (
          <>
            <dt>Current role</dt>
            <dd className="pw-denied__role">{role ?? '—'}</dd>
          </>
        ) : null}
        {grants !== undefined ? (
          <>
            <dt>Grants access</dt>
            <dd className="pw-denied__grants">
              {grants.map((g) => (
                <span key={g} className="pw-denied__chip">
                  {g}
                </span>
              ))}
            </dd>
          </>
        ) : null}
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
      <p className="pw-denied__foot">{footnote ?? DEFAULT_FOOT}</p>
    </div>
  );
}
