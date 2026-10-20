import { AUTH_PRODUCTS, SignInPage, ssoEntryHref } from '@aramo/fe-foundation';

// AUTH-SIGNIN-1 §3.3 — the ATS sign-in is the shared Aramo sign-in screen. The
// callback's failure redirect (`?error=CODE`) lands here too.
export function LoginPage() {
  return (
    <SignInPage
      product={AUTH_PRODUCTS.ats}
      notEntitledAction={
        // The App Home is a sibling SPA on this host (D-ORG-2 T1) — a host-level
        // link, not an ATS route.
        <a className="aramo-auth__btn" href={ssoEntryHref('/', 'org')} data-testid="login-open-app-home">
          Open the App Home
        </a>
      }
    />
  );
}
