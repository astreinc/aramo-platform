import { AUTH_PRODUCTS, AuthShell, Button, SignInPage, redirectToLogin, type SignInErrorCopy } from '@aramo/fe-foundation';

import './auth-pages.css';

// AUTH-SIGNIN-1 §3.3 — the platform console sign-in is the shared Aramo sign-in
// screen (configured `platform` consumer). The callback's failure redirect
// (`?error=CODE`) lands here too.
//
// PLATFORM-UX-1 F-2 (directive R-17, amendment 14) — the platform copy reaches
// SignInPage ONLY through its `errorCopy` prop, keyed by the real auth-service
// codes; SignInPage itself is not edited. Codes the design gives no copy for
// keep SignInPage's defaults. TENANT_ACCESS_DENIED deliberately keeps the
// default screen: an `errorCopy` override replaces the screen's actions with the
// provider buttons only, which would drop the wrong-account recovery ("Sign in
// with a different account" / "Sign out and start over") and the
// idp_not_permitted_for_tenant variant (typed divergence, see the F-2 report).
export const PLATFORM_SIGN_IN_ERROR_COPY: Readonly<Record<string, SignInErrorCopy>> = {
  // The session-expired code: the sign-in state expired or was started in
  // another tab (handoff §11 "Your session ended.").
  VALIDATION_ERROR: {
    title: 'Your session ended.',
    message: 'Sign in again to continue.',
    retry: true,
  },
  // The provider-failure code (handoff §11).
  INTERNAL_ERROR: {
    title: 'The sign-in provider didn’t respond.',
    message: 'Try again, or use the other provider.',
    retry: true,
  },
};

export function LoginPage() {
  return <SignInPage product={AUTH_PRODUCTS.platform} errorCopy={PLATFORM_SIGN_IN_ERROR_COPY} />;
}

// T2-E1-HF3 + PLATFORM-UX-1 F-2 (handoff §11) — the public signed-out landing
// with the platform copy. It is composed on the shared AuthShell frame (the
// shared SignedOut component's copy is fixed and cannot carry the designed
// text). Like SignedOut it performs ZERO automatic authentication: re-entry is
// an explicit button.
export function PlatformSignedOut() {
  return (
    <section className="aramo-signed-out pw-signedout" role="status" aria-live="polite">
      <AuthShell product={AUTH_PRODUCTS.platform}>
        <h1 className="aramo-auth__title">You&apos;ve signed out securely</h1>
        <p className="aramo-auth__sub">Your Platform administration session has ended on this device.</p>
        <div className="aramo-auth__actions">
          <Button unstyled className="aramo-auth__btn aramo-auth__btn--primary" onClick={() => redirectToLogin()}>
            Sign in again
          </Button>
          <Button unstyled className="aramo-auth__btn" onClick={() => redirectToLogin({ selectAccount: true })}>
            Sign in with a different account
          </Button>
        </div>
      </AuthShell>
    </section>
  );
}
