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

import { appPath, authPath, getAuthConsumer } from './consumer';

export interface Session {
  sub: string;
  // Inc-2 PR-2: 'platform' added so the platform console's session (whose token
  // carries consumer_type='platform') types cleanly. The FE never branches on
  // this field (RouteGuard keys on scopes); it is carried for completeness.
  consumer_type: 'recruiter' | 'portal' | 'ingestion' | 'platform' | 'sign' | 'org';
  tenant_id: string;
  scopes: string[];
  iat: number;
  exp: number;
}

export type SessionState =
  | { status: 'loading' }
  | { status: 'authenticated'; session: Session }
  | { status: 'unauthenticated' }
  // Host-binding SSO recovery — /session answered 403 TENANT_ACCESS_DENIED: the
  // browser holds a session for an account that does not belong to this host
  // (under AUTH_HOST_TENANT_BINDING=enforce). Distinct from 'unauthenticated' so
  // RouteGuard shows the wrong-account recovery page instead of silently
  // restarting a login that Microsoft SSO would answer with the same account.
  | { status: 'denied' };

// The same-origin landing for a wrong-account denial (the callback uses the same
// `?error=` contract — auth.controller.ts → /login?error=TENANT_ACCESS_DENIED).
export const TENANT_ACCESS_DENIED_PATH = '/login?error=TENANT_ACCESS_DENIED';
/** D-ORG-2 — the access-denied landing INSIDE this app (base-path aware). */
export function accessDeniedPath(): string {
  return appPath(TENANT_ACCESS_DENIED_PATH);
}
// D-ORG-2 — a same-host, relative deep link the auth callback returns the user to
// after sign-in (sealed server-side in the PKCE state; validated there against the
// consumer's app base). Only the current in-app location is ever offered.
export function currentReturnTo(): string | null {
  if (typeof window === 'undefined') return null;
  const { pathname, search, hash } = window.location;
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null;
  const rel = `${pathname}${search ?? ''}${hash ?? ''}`;
  // Never bounce back into the login/signed-out landings.
  if (/\/(login|signed-out)(\/|\?|#|$)/.test(pathname)) return null;
  // The app root (with or without the base) is the default landing anyway — no
  // return_to is needed, so the plain login path is preserved for it.
  const base = appPath('/').replace(/\/+$/, '');
  if (rel === '/' || rel === base || rel === `${base}/`) return null;
  return rel.length <= 2000 ? rel : null;
}

// Microsoft's fixed sign-out endpoint — the last-resort recovery when the user's
// Microsoft session keeps answering with the wrong account. A constant with NO
// parameters: nothing caller-supplied, so it cannot become an open redirect.
export const MICROSOFT_SIGN_OUT_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/logout';

export type FederatedIdp = 'google' | 'microsoft';

export interface LoginOptions {
  selectAccount?: boolean;
  // D-ORG-2 — explicit deep link to return to after sign-in; null disables,
  // undefined (default) uses the current in-app location.
  returnTo?: string | null;
  // AUTH-SIGNIN-1 §3.2.2 — the provider button chosen on the sign-in page. The
  // auth-service maps it through a closed allowlist; a tenant's pin wins.
  idp?: FederatedIdp;
  // AUTH-SIGNIN-1 §3.2.1 — an allowlisted consumer from the sign-in page's
  // `?consumer=`; default is the configured consumer.
  consumer?: string;
}

// AUTH-SIGNIN-1 — the consumers whose apps serve the shared Aramo sign-in page at
// their own `/login`. The passwordless portal keeps its own login (unchanged).
const SIGN_IN_PAGE_CONSUMERS: ReadonlySet<string> = new Set(['recruiter', 'org', 'sign', 'platform']);

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

/** The auth-service login (the IdP round-trip) — what a sign-in button navigates to. */
export function loginUrl(options: LoginOptions = {}): string {
  const params = new URLSearchParams();
  if (options.idp !== undefined) params.set('idp', options.idp);
  if (options.selectAccount === true) params.set('select_account', '1');
  const returnTo = options.returnTo === undefined ? currentReturnTo() : options.returnTo;
  if (returnTo !== null && returnTo !== undefined) params.set('return_to', returnTo);
  const qs = params.toString();
  const path = authPath('login', options.consumer);
  return qs.length > 0 ? `${path}?${qs}` : path;
}

/** AUTH-SIGNIN-1 §3.2.2 — this app's own sign-in page (`/login`, base-path aware). */
export function signInPageUrl(returnTo: string | null | undefined = currentReturnTo()): string {
  const page = appPath('/login');
  return returnTo === null || returnTo === undefined
    ? page
    : `${page}?${new URLSearchParams({ return_to: returnTo }).toString()}`;
}

// AUTH-SIGNIN-1 §3.2.2 — an unauthenticated user goes to the app's own Aramo
// sign-in page (which then offers the provider buttons), not straight to the
// IdP. An explicit account-switch (`selectAccount`) or a chosen provider (`idp`)
// still goes straight to the auth-service login, as does the portal consumer.
export function redirectToLogin(options: LoginOptions = {}): void {
  const direct =
    options.selectAccount === true ||
    options.idp !== undefined ||
    !SIGN_IN_PAGE_CONSUMERS.has(options.consumer ?? getAuthConsumer());
  window.location.assign(direct ? loginUrl(options) : signInPageUrl(options.returnTo));
}

export function redirectToAccessDenied(): void {
  window.location.assign(accessDeniedPath());
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
      .catch((error: unknown) => {
        if (cancelled) return;
        setState(
          error instanceof ApiError && error.status === 403 && error.code === 'TENANT_ACCESS_DENIED'
            ? { status: 'denied' }
            : { status: 'unauthenticated' },
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
