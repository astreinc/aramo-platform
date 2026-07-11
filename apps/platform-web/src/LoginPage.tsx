import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, Card, InlineAlert, redirectToLogin } from '@aramo/fe-foundation';

// Inc-3 PR-3.5 (Workstream B) — platform-web's login landing.
//
// Same param, same pattern as ats-web's LoginPage: the auth-service callback
// (Workstream A) navigates here on a platform login failure with `?error=<CODE>`
// instead of returning raw JSON. platform-web has no tenant-lifecycle audience,
// so a single generic auth-failure page (with retry) is sufficient here. With no
// `?error=`, this bounces straight to the platform IdP login (the configured
// `platform` consumer) — the same effect RouteGuard has for a clean entry.
interface LoginPageProps {
  onMount?: () => void;
}

export function LoginPage({ onMount }: LoginPageProps) {
  const [params] = useSearchParams();
  const error = params.get('error');

  useEffect(() => {
    if (error === null) {
      (onMount ?? redirectToLogin)();
    }
  }, [error, onMount]);

  if (error === null) {
    return (
      <div className="pw-page" style={{ maxWidth: 480 }}>
        <p>Redirecting to sign-in…</p>
      </div>
    );
  }

  return (
    <div className="pw-page" style={{ maxWidth: 480 }}>
      <Card
        title="Sign-in failed"
        footer={
          <Button variant="primary" onClick={() => redirectToLogin()}>
            Try signing in again
          </Button>
        }
      >
        <InlineAlert variant="error">
          We could not complete your sign-in to the platform console. Please try
          again, and contact the platform team if the problem continues.
        </InlineAlert>
      </Card>
    </div>
  );
}
