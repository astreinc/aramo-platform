import {
  MICROSOFT_SIGN_OUT_URL,
  logout,
  redirectToLogin,
} from '../auth/session';

import { Button } from './Button';
import { Card } from './Card';
import { InlineAlert } from './InlineAlert';

// Host-binding SSO recovery — the page for `?error=TENANT_ACCESS_DENIED`.
//
// The user reached a host with a Microsoft account that does not belong to it
// (typically: switching between the ATS and the platform console in one browser,
// where Microsoft SSO silently re-uses the account signed in last). Three
// explicit, click-driven recoveries, strongest last — NO automatic navigation:
//
//   1. "Sign in with a different account" → /auth/<consumer>/login?select_account=1
//      → Cognito prompt=select_account, forwarded to Microsoft's account picker.
//   2. "Sign out and start over" → the shared logout (Aramo session + Cognito SSO
//      session) → /signed-out, which offers the account picker again.
//   3. "Sign out of Microsoft" → Microsoft's FIXED sign-out URL (no parameters).
//
// The copy names no tenant, workspace or account: a mismatched host must never
// learn or disclose which tenant the signed-in identity belongs to.
interface WrongAccountRecoveryProps {
  // Test seams — replace the real top-level navigations.
  onSelectAccount?: () => void;
  onSignOut?: () => void;
}

export function WrongAccountRecovery({ onSelectAccount, onSignOut }: WrongAccountRecoveryProps) {
  return (
    <Card
      title="Signed in with a different account"
      footer={
        <>
          <Button
            variant="primary"
            onClick={() => (onSelectAccount ?? (() => redirectToLogin({ selectAccount: true })))()}
          >
            Sign in with a different account
          </Button>{' '}
          <Button variant="secondary" onClick={() => (onSignOut ? onSignOut() : void logout())}>
            Sign out and start over
          </Button>
        </>
      }
    >
      <InlineAlert variant="error">
        The account you signed in with doesn&apos;t have access here. This usually
        happens when another Microsoft account is already signed in on this
        browser.
      </InlineAlert>
      <p>
        Choose the account you use for this site. If Microsoft keeps signing you
        in with the wrong account,{' '}
        <a href={MICROSOFT_SIGN_OUT_URL} rel="noopener noreferrer">
          sign out of Microsoft
        </a>{' '}
        and then sign in again.
      </p>
    </Card>
  );
}
