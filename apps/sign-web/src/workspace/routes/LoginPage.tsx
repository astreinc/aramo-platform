import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AUTH_PRODUCTS, SignInPage } from '@aramo/fe-foundation';

// AUTH-SIGNIN-1 §3.3 — the Aramo Sign sign-in is the shared Aramo sign-in screen.
// The /auth/sign/callback failure redirect (`?error=CODE`) lands here too.
//
// Self-service sign-up links: each is offered only while its sign-up is switched
// on. The public sign-up routes are how that state is exposed — every route
// answers 404 while it is off (Business: SIGN_PUBLIC_SIGNUP_ENABLED; Personal:
// SIGN_PERSONAL_SIGNUP_MODE `off`), the same probe /signup already uses. A
// failed probe hides the link (fail closed).

const SIGNUP_API = '/v1/signup/sign';

async function signupAvailable(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${SIGNUP_API}/${path}`, { headers: { Accept: 'application/json' } });
    return res.ok;
  } catch {
    return false;
  }
}

export function useSignupAvailability(): { personal: boolean; business: boolean } {
  const [state, setState] = useState({ personal: false, business: false });
  useEffect(() => {
    let cancelled = false;
    void Promise.all([signupAvailable('personal/terms'), signupAvailable('terms')]).then(([personal, business]) => {
      if (!cancelled) setState({ personal, business });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export function LoginPage() {
  const { personal, business } = useSignupAvailability();
  const accountLinks =
    personal || business ? (
      <div className="aramo-auth__aside" data-testid="signin-create-account">
        <b>New to Aramo Sign?</b>
        {personal ? (
          <div>
            <Link to="/signup/personal">Create a Personal account</Link>
          </div>
        ) : null}
        {business ? (
          <div>
            <Link to="/signup">Create a Business account</Link>
          </div>
        ) : null}
      </div>
    ) : undefined;
  // Apple Go-Live A1 L-3 path 2 — "Create a new account" on the no-account
  // pending-link panel: the Personal signup, which starts with Continue with Apple (R-5).
  const newAccountAction = personal ? (
    <Link className="aramo-auth__btn" to="/signup/personal" data-testid="link-create-account">
      Create a new account
    </Link>
  ) : undefined;
  return (
    <SignInPage
      product={AUTH_PRODUCTS.sign}
      signerNote
      accountLinks={accountLinks}
      {...(newAccountAction !== undefined ? { newAccountAction } : {})}
    />
  );
}
