import { describe, expect, it, vi } from 'vitest';

import { apiClient } from '../api/client';

import { fetchSession, logout, LOGOUT_PATH, type Session } from './session';

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
