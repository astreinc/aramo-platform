import { AuthShell, resolveAuthProduct, type AuthProduct } from '../auth/AuthShell';
import { redirectToLogin } from '../auth/session';

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
// Re-entry is EXPLICIT (R3/R4): the "Sign in again" action reuses the canonical
// login entry (redirectToLogin → this app's Aramo sign-in page, AUTH-SIGNIN-1
// §3.2.3). A surviving Google or Microsoft session may then satisfy SSO
// silently — that is expected enterprise behavior, not a defect.
//
// Visual design and copy follow the PO's sign-in prototype (AUTH-SIGNIN-1).
interface SignedOutProps {
  // Host-binding SSO recovery — Microsoft-SSO surfaces (ats-web, platform-web)
  // also offer "Sign in with a different account" (Microsoft's account picker).
  // Opt-in: portal-web's passwordless login has no account to switch.
  offerAccountSwitch?: boolean;
  /** Product presentation (AUTH_PRODUCTS.*); default is a generic Aramo frame. */
  product?: AuthProduct;
}

export function SignedOut({ offerAccountSwitch = false, product }: SignedOutProps = {}) {
  const p = resolveAuthProduct(product);
  return (
    <section className="aramo-signed-out" role="status" aria-live="polite">
      <AuthShell product={p}>
        <span className="aramo-auth__tile aramo-auth__tile--green">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <h1 className="aramo-auth__title aramo-auth__title--error">You&apos;ve signed out securely.</h1>
        <p className="aramo-auth__sub">
          You&apos;re signed out of {p.name} on this device. You&apos;ll stay signed out until you choose to sign in again.
        </p>
        <div className="aramo-auth__actions">
          <button type="button" className="aramo-auth__btn aramo-auth__btn--primary" onClick={() => redirectToLogin()}>
            Sign in again
          </button>
          {offerAccountSwitch ? (
            <button type="button" className="aramo-auth__btn" onClick={() => redirectToLogin({ selectAccount: true })}>
              Sign in with a different account
            </button>
          ) : null}
        </div>
        <div className="aramo-auth__fine">
          On a shared computer, also sign out of your identity provider account.
        </div>
      </AuthShell>
    </section>
  );
}
