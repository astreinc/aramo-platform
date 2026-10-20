import { AUTH_PRODUCTS, SignInPage } from '@aramo/fe-foundation';

// AUTH-SIGNIN-1 §3.3 — the Aramo Sign sign-in is the shared Aramo sign-in screen.
// The /auth/sign/callback failure redirect (`?error=CODE`) lands here too.
export function LoginPage() {
  return (
    <SignInPage
      product={AUTH_PRODUCTS.sign}
      signerNote
    />
  );
}
