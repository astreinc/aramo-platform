import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, InlineAlert, WrongAccountRecovery, redirectToLogin } from '@aramo/fe-foundation';

// Inc-3 PR-3.5 (Workstream B) — the App Home's login landing (D-ORG). Same param,
// same pattern as ats-web: the auth-service /auth/org/callback navigates here on a
// login failure with `?error=<CODE>`.
//
// Two modes:
//   - No `?error=` → the normal entry: bounce straight to the IdP hosted UI
//     (unchanged pre-3.5 behavior).
//   - `?error=<CODE>` → the auth-service callback (Workstream A) NAVIGATED here
//     on a login failure instead of dumping raw JSON. Render a humane page for
//     the tenant-lifecycle codes; a generic auth-failure otherwise. The suspended
//     page (the Inc-1 raw-JSON screenshot class) is now extinct.
//
// Copy is static v1 (a "contact your provider" affordance, no live operator
// contact wiring). fe-foundation primitives only (Card / InlineAlert / Button).

interface LoginPageProps {
  // Test seam — the redirect performed when there is no error to show.
  onMount?: () => void;
}

interface ErrorCopy {
  title: string;
  message: string;
  retry: boolean;
}

// The lifecycle codes get bespoke copy; everything else falls to the generic
// auth-failure. TENANT_CLOSED is terminal (no retry — signing in again cannot
// help); SUSPENDED and generic offer a retry.
function copyForError(code: string): ErrorCopy {
  switch (code) {
    case 'TENANT_SUSPENDED':
      return {
        title: 'Workspace suspended',
        message:
          'This workspace has been suspended, so sign-in is paused. Please contact your provider to restore access.',
        retry: true,
      };
    // D-ORG (§3.C) — the `org` consumer requires the `core` capability (the
    // tenant must BE an Aramo organization). Retrying cannot help.
    case 'TENANT_CAPABILITY_NOT_ENTITLED':
      return {
        title: 'Organization not available',
        message:
          'This organization is not set up for Aramo yet. Please contact your organization administrator.',
        retry: false,
      };
    case 'TENANT_CLOSED':
      return {
        title: 'Workspace closed',
        message:
          'This workspace has been closed and is no longer available. Please contact your provider if you believe this is a mistake.',
        retry: false,
      };
    default:
      return {
        title: 'Sign-in failed',
        message:
          'We could not complete your sign-in. Please try again, and contact your provider if the problem continues.',
        retry: true,
      };
  }
}

export function LoginPage({ onMount }: LoginPageProps) {
  const [params] = useSearchParams();
  const error = params.get('error');

  useEffect(() => {
    // Only auto-redirect on the clean entry (no error to show). When the
    // callback navigated here with an error, we render the page and let the
    // user read it — never bounce them straight back into a failing loop.
    if (error === null) {
      (onMount ?? redirectToLogin)();
    }
  }, [error, onMount]);

  if (error === null) {
    return (
      <section className="aramo-login">
        <p>Redirecting to sign-in…</p>
      </section>
    );
  }

  // Host-binding SSO recovery — the signed-in Microsoft account does not belong
  // to this host. Account-recovery actions, not a plain retry (a retry would let
  // Microsoft SSO silently pick the same account again).
  if (error === 'TENANT_ACCESS_DENIED') {
    return (
      <section className="aramo-login">
        <WrongAccountRecovery />
      </section>
    );
  }

  const copy = copyForError(error);

  return (
    <section className="aramo-login">
      <Card
        title={copy.title}
        footer={
          copy.retry ? (
            <Button variant="primary" onClick={() => redirectToLogin()}>
              Try signing in again
            </Button>
          ) : error === 'TENANT_CAPABILITY_NOT_ENTITLED' ? (
            <a className="rc-link-action" href="/" data-testid="login-open-app-home">
              Open the App Home
            </a>
          ) : undefined
        }
      >
        <InlineAlert variant="error">{copy.message}</InlineAlert>
      </Card>
    </section>
  );
}
