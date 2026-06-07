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

export interface Session {
  sub: string;
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  tenant_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; session: Session }
  | { status: 'unauthenticated' };

export const LOGIN_PATH = '/auth/recruiter/login';
export const SESSION_PATH = '/auth/recruiter/session';
export const LOGOUT_PATH = '/auth/recruiter/logout';

export async function fetchSession(): Promise<Session | null> {
  try {
    return await apiClient.get<Session>(SESSION_PATH);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 401) {
      return null;
    }
    throw error;
  }
}

export function redirectToLogin(): void {
  window.location.assign(LOGIN_PATH);
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
