import { SignInPage } from '@aramo/fe-foundation';

// AUTH-SIGNIN-1 §3.3 — the ATS sign-in is the shared Aramo sign-in screen. The
// callback's failure redirect (`?error=CODE`) lands here too.
export function LoginPage() {
  return (
    <SignInPage
      productName="Aramo ATS"
      notEntitledAction={
        // The App Home is a sibling SPA on this host (D-ORG-2 T1) — a host-level
        // link, not an ATS route.
        <a className="rc-link-action" href="/" data-testid="login-open-app-home">
          Open the App Home
        </a>
      }
      errorCopy={{
        TENANT_CAPABILITY_NOT_ENTITLED: {
          title: 'Product not available',
          message:
            "This product is not included in your organization's Aramo subscription. Open the App Home to see the products available to you, or contact your organization administrator.",
          retry: false,
        },
      }}
    />
  );
}
