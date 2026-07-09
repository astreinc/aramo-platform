// Session bootstrap (PR-8 §4.2).
//
// Calls /auth/recruiter/session to confirm an authenticated session
// exists on app boot. Response shape mirrors openapi/auth.yaml
// SessionResponse — 6 fields, additionalProperties: false. The
// frontend types lock to that shape so R10 (no examination output
// exposure) is enforced at the type level: anything not in this
// type cannot leak into UI.

import { useEffect, useState } from 'react';

import { ApiError, apiClient } from '../api/client';
import { authPath } from './consumer';

export interface Session {
  sub: string;
  // Inc-2 PR-2: 'platform' added so the platform console's session (whose token
  // carries consumer_type='platform') types cleanly. The FE never branches on
  // this field (RouteGuard keys on scopes); it is carried for completeness.
  consumer_type: 'recruiter' | 'portal' | 'ingestion' | 'platform';
  tenant_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; session: Session }
  | { status: 'unauthenticated' };

// The default-consumer ('recruiter') paths, retained as named exports for
// backward compatibility. The functions below derive paths from the CONFIGURED
// consumer (configureAuthConsumer, default 'recruiter') — so with no
// configuration these values and the runtime paths coincide exactly.
export const LOGIN_PATH = '/auth/recruiter/login';
export const SESSION_PATH = '/auth/recruiter/session';
export const LOGOUT_PATH = '/auth/recruiter/logout';

export async function fetchSession(): Promise<Session | null> {
  try {
    return await apiClient.get<Session>(authPath('session'));
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export function redirectToLogin(): void {
  window.location.assign(authPath('login'));
}

// §5 Auth-Hardening D3 — the shared session logout (terminates BOTH sessions).
//
//   1. POST /logout clears the LOCAL app session — cookies + Aramo refresh-
//      token revoke (already built; preserved).
//   2. The browser then NAVIGATES to GET /logout (same path, method-
//      differentiated), which 302-redirects to the Cognito hosted-UI /logout
//      to terminate the Cognito SSO session and return to the registered
//      post-logout page. Step 2 closes the re-entry-without-reauth hole the
//      local clear alone leaves open.
//
// This is the ONE shared logout for EVERY consumer — the recruiter surface and
// the admin surface both ride this single session (§C: §5 Auth-Hardening is
// where the shared auth is meant to evolve). The local POST is best-effort:
// the user's outcome (navigate to the Cognito logout) is identical whether it
// succeeds or fails, and no internal detail is surfaced (R10/R12).
//
// `onComplete` is a test seam — it replaces the real top-level browser
// navigation so specs can assert the flow without leaving jsdom.
export async function logout(onComplete?: () => void): Promise<void> {
  const logoutPath = authPath('logout');
  try {
    await apiClient.post(logoutPath);
  } catch {
    // Swallow: same outcome on success or failure; no detail leak.
  }
  (onComplete ?? (() => window.location.assign(logoutPath)))();
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    fetchSession()
      .then((session) => {
        if (cancelled) return;
        setState(
          session === null
            ? { status: 'unauthenticated' }
            : { status: 'authenticated', session },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setState({ status: 'unauthenticated' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
