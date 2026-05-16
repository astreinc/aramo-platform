import type { ReactNode } from 'react';

import {
  redirectToLogin,
  useSession,
  type SessionState,
} from './session';

interface RouteGuardProps {
  children: ReactNode;
  // Test seam: lets the test inject a session state without mounting
  // the real fetch-driven hook.
  sessionStateOverride?: SessionState;
  onRedirect?: () => void;
}

export function RouteGuard({
  children,
  sessionStateOverride,
  onRedirect,
}: RouteGuardProps) {
  const state = sessionStateOverride ?? useSession();

  if (state.status === 'loading') {
    return <p>Loading session…</p>;
  }

  if (state.status === 'unauthenticated') {
    (onRedirect ?? redirectToLogin)();
    return null;
  }

  return <>{children}</>;
}
