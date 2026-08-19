import { redirectToLogin } from '../auth/session';

import { Button } from './Button';
import { Card } from './Card';

// T2-E1-HF3 (ruling HF3-G5-R1) — the canonical public signed-out landing.
//
// This is the stable destination the Cognito logout returns the browser to
// (deriveSignoutRedirect → `/signed-out`). It is mounted OUTSIDE RouteGuard on
// every interactive browser consumer, so it renders session-less and performs
// ZERO automatic authentication: there is no useEffect / on-mount redirect, no
// session probe that initiates login, and no client-side "logged out" flag. The
// signed-out state is real — it derives from the actual session boundary (the
// user is here only because logout cleared the Aramo session and Cognito's SSO
// cookie).
//
// Re-entry is EXPLICIT (R3/R4): the "Sign in again" action reuses the existing
// canonical login entry (redirectToLogin → /auth/<consumer>/login) unchanged.
// The user's surviving Microsoft enterprise session may then satisfy SSO
// silently — that is expected enterprise behavior, not a defect.
export function SignedOut() {
  return (
    <section className="aramo-signed-out" role="status" aria-live="polite">
      <Card
        title="You're signed out"
        description="Your Aramo session has ended. You'll stay signed out until you choose to sign in again."
        footer={
          <Button variant="primary" onClick={() => redirectToLogin()}>
            Sign in again
          </Button>
        }
      >
        <p>
          You can close this tab, or sign in again when you're ready. Your
          Microsoft account may still be signed in elsewhere.
        </p>
      </Card>
    </section>
  );
}
