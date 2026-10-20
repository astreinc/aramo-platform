import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { apiClient } from '../api/client';

import {
  fetchSession,
  LOGIN_PATH,
  loginUrl,
  logout,
  LOGOUT_PATH,
  MICROSOFT_SIGN_OUT_URL,
  redirectToAccessDenied,
  redirectToLogin,
  TENANT_ACCESS_DENIED_PATH,
  useSession,
  type Session,
} from './session';

const sample: Session = {
  sub: '00000000-0000-0000-0000-000000000001',
  consumer_type: 'recruiter',
  tenant_id: '00000000-0000-0000-0000-000000000002',
  scopes: ['session:read'],
  iat: 1_700_000_000,
  exp: 1_700_000_900,
};

describe('fetchSession', () => {
  it('returns the parsed session on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(sample), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchSession()).resolves.toEqual(sample);
  });

  it('returns null on 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 401 }),
    );

    await expect(fetchSession()).resolves.toBeNull();
  });

  it('rethrows on non-401 failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 500 }),
    );

    await expect(fetchSession()).rejects.toThrow(/500/);
  });
});

// §5 Auth-Hardening D3 — the shared session logout (the ONE logout for every
// consumer). Step 1 POSTs the local clear; step 2 navigates to GET /logout,
// which the backend 302-redirects to the Cognito hosted-UI /logout (SSO
// termination). `onComplete` stands in for the real browser navigation.
describe('logout', () => {
  it('POSTs the local clear then runs the completion seam', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue(undefined);
    const onComplete = vi.fn();

    await logout(onComplete);

    expect(post).toHaveBeenCalledWith(LOGOUT_PATH);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('still completes (navigates to the Cognito logout) when the local POST fails', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('network'));
    const onComplete = vi.fn();

    await logout(onComplete);

    // Same outcome on success or failure — no detail surfaced (R10/R12).
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('defaults to navigating the browser to GET /logout (→ Cognito hosted-UI /logout)', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue(undefined);
    // jsdom's location.assign is non-configurable, so swap the whole
    // location object for the assertion, then restore it.
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { assign },
    });
    try {
      await logout();
      // The navigation target IS the GET /logout path (same path as the POST,
      // method-differentiated); the backend 302s it on to Cognito's /logout.
      expect(assign).toHaveBeenCalledWith(LOGOUT_PATH);
    } finally {
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: original,
      });
    }
  });
});

// Host-binding SSO recovery — the account-picker login and the wrong-account
// session state.
describe('host-binding SSO recovery', () => {
  function withAssign(fn: (assign: ReturnType<typeof vi.fn>) => void): void {
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { assign } });
    try {
      fn(assign);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  }

  it('loginUrl: default is the plain login path; selectAccount adds ?select_account=1 (same path, no other change)', () => {
    expect(loginUrl()).toBe(LOGIN_PATH);
    expect(loginUrl({ selectAccount: false })).toBe(LOGIN_PATH);
    expect(loginUrl({ selectAccount: true })).toBe(`${LOGIN_PATH}?select_account=1`);
  });

  it('redirectToLogin({ selectAccount: true }) navigates to the account-picker login', () => {
    withAssign((assign) => {
      redirectToLogin({ selectAccount: true });
      expect(assign).toHaveBeenCalledWith(`${LOGIN_PATH}?select_account=1`);
    });
  });

  // AUTH-SIGNIN-1 §3.2.2
  it('loginUrl: idp and an explicit consumer build the auth-service login', () => {
    expect(loginUrl({ idp: 'google', returnTo: '/ats/x' })).toBe(`${LOGIN_PATH}?idp=google&return_to=%2Fats%2Fx`);
    expect(loginUrl({ idp: 'microsoft', consumer: 'org', returnTo: null })).toBe('/auth/org/login?idp=microsoft');
  });

  it('redirectToLogin() (unauthenticated) goes to the app sign-in page, not the IdP', () => {
    withAssign((assign) => {
      redirectToLogin({ returnTo: '/ats/requisitions' });
      expect(assign).toHaveBeenCalledWith('/login?return_to=%2Fats%2Frequisitions');
      redirectToLogin({ returnTo: null });
      expect(assign).toHaveBeenLastCalledWith('/login');
    });
  });

  it('redirectToLogin({ idp }) goes straight to the auth-service login', () => {
    withAssign((assign) => {
      redirectToLogin({ idp: 'microsoft', returnTo: null });
      expect(assign).toHaveBeenCalledWith(`${LOGIN_PATH}?idp=microsoft`);
    });
  });

  it('the passwordless portal consumer keeps the direct login', () => {
    withAssign((assign) => {
      redirectToLogin({ consumer: 'portal', returnTo: null });
      expect(assign).toHaveBeenCalledWith('/auth/portal/login');
    });
  });

  it('redirectToAccessDenied navigates to the same-origin recovery page', () => {
    withAssign((assign) => {
      redirectToAccessDenied();
      expect(assign).toHaveBeenCalledWith('/login?error=TENANT_ACCESS_DENIED');
    });
    expect(TENANT_ACCESS_DENIED_PATH.startsWith('/')).toBe(true);
  });

  it('MICROSOFT_SIGN_OUT_URL is a fixed Microsoft endpoint with no parameters (no open redirect)', () => {
    const url = new URL(MICROSOFT_SIGN_OUT_URL);
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.search).toBe('');
  });

  it('useSession → "denied" on 403 TENANT_ACCESS_DENIED; any other 403 stays "unauthenticated"', async () => {
    const respond = (code: string) =>
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { code, message: 'x', request_id: 'r' } }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    respond('TENANT_ACCESS_DENIED');
    const denied = renderHook(() => useSession());
    await waitFor(() => expect(denied.result.current.status).toBe('denied'));
    vi.restoreAllMocks();
    respond('SOMETHING_ELSE');
    const other = renderHook(() => useSession());
    await waitFor(() => expect(other.result.current.status).toBe('unauthenticated'));
  });
});
