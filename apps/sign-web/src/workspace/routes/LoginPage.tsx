import { SignInPage } from '@aramo/fe-foundation';

// AUTH-SIGNIN-1 §3.3 — the Aramo Sign sign-in is the shared Aramo sign-in screen.
// The /auth/sign/callback failure redirect (`?error=CODE`) lands here too.
export function LoginPage() {
  return (
    <SignInPage
      productName="Aramo Sign"
      errorCopy={{
        TENANT_CAPABILITY_NOT_ENTITLED: {
          title: 'Aramo Sign not available',
          message:
            "Aramo Sign is not included in your organization's Aramo subscription. Please contact your organization administrator.",
          retry: false,
        },
      }}
    />
  );
}
