import type { ReactNode } from 'react';

import { ForbiddenState } from '../components/ForbiddenState';

import { hasScope } from './scopes';
import {
  redirectToAccessDenied,
  redirectToLogin,
  useSession,
  type SessionState,
} from './session';

interface RouteGuardProps {
  children: ReactNode;
  // The optional scope axis (Settings S5a). When supplied, an
  // authenticated session that does NOT carry the scope renders
  // <ForbiddenState> — NOT a redirect to login. A login redirect on an
  // authenticated-but-unauthorized session would loop (the next /session
  // probe still succeeds; the missing scope is a policy outcome, not an
  // authentication failure).
  requireScope?: string;
  // Test seam: lets the test inject a session state without mounting
  // the real fetch-driven hook.
  sessionStateOverride?: SessionState;
  onRedirect?: () => void;
  // Test seam for the wrong-account (403 TENANT_ACCESS_DENIED) navigation.
  onDenied?: () => void;
}

export function RouteGuard({
  children,
  requireScope,
  sessionStateOverride,
  onRedirect,
  onDenied,
}: RouteGuardProps) {
  const state = sessionStateOverride ?? useSession();

  if (state.status === 'loading') {
    return <p>Loading session…</p>;
  }

  // Wrong account for this host: show the recovery page. Never auto-restart the
  // login — Microsoft SSO would silently answer with the same account (loop).
  if (state.status === 'denied') {
    (onDenied ?? redirectToAccessDenied)();
    return null;
  }

  if (state.status === 'unauthenticated') {
    (onRedirect ?? redirectToLogin)();
    return null;
  }

  if (requireScope !== undefined && !hasScope(state.session, requireScope)) {
    return <ForbiddenState scope={requireScope} />;
  }

  return <>{children}</>;
}
