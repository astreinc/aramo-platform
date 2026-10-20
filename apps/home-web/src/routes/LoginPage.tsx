import { AUTH_PRODUCTS, SignInPage } from '@aramo/fe-foundation';

// AUTH-SIGNIN-1 §3.3 — the App Home sign-in is the shared Aramo sign-in screen.
// The /auth/org/callback failure redirect (`?error=CODE`) lands here too.
export function LoginPage() {
  return (
    <SignInPage
      product={AUTH_PRODUCTS.home}
      errorCopy={{
        // D-ORG (§3.C) — the `org` consumer requires the `core` capability (the
        // tenant must BE an Aramo organization). Retrying cannot help.
        TENANT_CAPABILITY_NOT_ENTITLED: {
          title: 'Organization not available',
          message: 'This organization is not set up for Aramo yet. Please contact your organization administrator.',
          retry: false,
        },
      }}
    />
  );
}
