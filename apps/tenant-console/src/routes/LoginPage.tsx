import { useEffect } from 'react';
import { redirectToLogin } from '@aramo/fe-foundation';

interface LoginPageProps {
  // Test seam.
  onMount?: () => void;
}

export function LoginPage({ onMount }: LoginPageProps) {
  useEffect(() => {
    (onMount ?? redirectToLogin)();
  }, [onMount]);

  return (
    <section className="aramo-login">
      <p>Redirecting to sign-in…</p>
    </section>
  );
}
