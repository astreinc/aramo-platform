import { SignInPage } from '@aramo/fe-foundation';

// AUTH-SIGNIN-1 §3.3 — the platform console sign-in is the shared Aramo sign-in
// screen (configured `platform` consumer). The callback's failure redirect
// (`?error=CODE`) lands here too.
export function LoginPage() {
  return <SignInPage productName="the Aramo platform console" />;
}
