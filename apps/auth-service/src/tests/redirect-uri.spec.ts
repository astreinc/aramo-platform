import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deriveBaseFromHost,
  derivePostLoginRedirect,
  deriveRedirectUri,
  deriveSignoutRedirect,
} from '../app/auth/redirect-uri.js';

// Increment-1 Amendment v1.2 (Workstream D) + Increment-3 PR-3.1 (host-derived
// base). The Amendment-v1.2 invariants (env precedence, legacy origin fallback,
// trailing-slash normalization, fail-closed null) still hold with an UNSET host;
// PR-3.1 adds validated-host derivation FIRST and the §2 security invariant: a
// raw Host header never reaches a redirect (hostile host → null → env fallback).

const ENV_KEYS = [
  'AUTH_PUBLIC_BASE_URL',
  'AUTH_COGNITO_REDIRECT_URI',
  'AUTH_PLATFORM_HOSTS',
  'AUTH_POST_LOGIN_PATH',
  'AUTH_POST_LOGIN_REDIRECT',
  'AUTH_SIGNOUT_PATH',
  'AUTH_COGNITO_SIGNOUT_REDIRECT',
  'AUTH_ALLOW_INSECURE_COOKIES',
  'NODE_ENV',
] as const;

let saved: Partial<Record<string, string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// dev posture = NODE_ENV !== 'production' && AUTH_ALLOW_INSECURE_COOKIES==='true'
function setDevPosture(): void {
  process.env['NODE_ENV'] = 'test';
  process.env['AUTH_ALLOW_INSECURE_COOKIES'] = 'true';
}
function setProdPosture(): void {
  process.env['NODE_ENV'] = 'production';
  delete process.env['AUTH_ALLOW_INSECURE_COOKIES'];
}

describe('deriveRedirectUri — Amendment v1.2 env chain (host unset)', () => {
  it('derives a per-consumer callback path from AUTH_PUBLIC_BASE_URL', () => {
    process.env['AUTH_PUBLIC_BASE_URL'] = 'http://localhost:4201';
    expect(deriveRedirectUri('platform')).toBe('http://localhost:4201/auth/platform/callback');
    expect(deriveRedirectUri('recruiter')).toBe('http://localhost:4201/auth/recruiter/callback');
  });

  it('normalizes a trailing slash on the base', () => {
    process.env['AUTH_PUBLIC_BASE_URL'] = 'http://localhost:4201/';
    expect(deriveRedirectUri('platform')).toBe('http://localhost:4201/auth/platform/callback');
  });

  it('deprecation fallback: derives the ORIGIN of legacy AUTH_COGNITO_REDIRECT_URI', () => {
    process.env['AUTH_COGNITO_REDIRECT_URI'] = 'https://astre.aramo.ai/auth/recruiter/callback';
    expect(deriveRedirectUri('platform')).toBe('https://astre.aramo.ai/auth/platform/callback');
  });

  it('AUTH_PUBLIC_BASE_URL takes precedence over the legacy env', () => {
    process.env['AUTH_PUBLIC_BASE_URL'] = 'http://localhost:4201';
    process.env['AUTH_COGNITO_REDIRECT_URI'] = 'https://legacy.example/auth/recruiter/callback';
    expect(deriveRedirectUri('platform')).toBe('http://localhost:4201/auth/platform/callback');
  });

  it('returns null (fail-closed → caller throws) when neither env is set', () => {
    expect(deriveRedirectUri('platform')).toBeNull();
  });
});

describe('deriveBaseFromHost — PR-3.1 three-class host validation', () => {
  it('TENANT host (caller-validated) → https base, host-derived (no env needed)', () => {
    expect(deriveBaseFromHost('astre.aramo.ai', { isTenantHost: true })).toBe('https://astre.aramo.ai');
  });

  it('PLATFORM host via AUTH_PLATFORM_HOSTS → https base', () => {
    process.env['AUTH_PLATFORM_HOSTS'] = 'admin.aramo.ai';
    expect(deriveBaseFromHost('admin.aramo.ai', { isTenantHost: false })).toBe('https://admin.aramo.ai');
  });

  it('PLATFORM host matching is port-stripped + lowercased', () => {
    process.env['AUTH_PLATFORM_HOSTS'] = ' Admin.Aramo.ai , other.aramo.ai ';
    expect(deriveBaseFromHost('admin.aramo.ai:443', { isTenantHost: false })).toBe('https://admin.aramo.ai');
  });

  it('LOCALHOST under DEV posture → http base (keeps the port)', () => {
    setDevPosture();
    expect(deriveBaseFromHost('localhost:4202', { isTenantHost: false })).toBe('http://localhost:4202');
    expect(deriveBaseFromHost('127.0.0.1:4201', { isTenantHost: false })).toBe('http://127.0.0.1:4201');
  });

  it('LOCALHOST under PROD posture → REFUSED (null → env fallback)', () => {
    setProdPosture();
    expect(deriveBaseFromHost('localhost:4202', { isTenantHost: false })).toBeNull();
  });

  // ── THE OPEN-REDIRECT SPEC (§2, required) ──
  it('HOSTILE host (evil.com) → REFUSED (null), never derived — the raw Host never reaches a redirect', () => {
    process.env['AUTH_PLATFORM_HOSTS'] = 'admin.aramo.ai';
    setDevPosture(); // even in the most permissive posture, a hostile host is refused
    expect(deriveBaseFromHost('evil.com', { isTenantHost: false })).toBeNull();
    // A hostile host claiming a tenant apex but NOT an active tenant (isTenantHost
    // false, as findActiveBySlug would return null) is also refused.
    expect(deriveBaseFromHost('evil.aramo.ai', { isTenantHost: false })).toBeNull();
    // Non-host-shaped inputs are refused outright.
    expect(deriveBaseFromHost('evil.com/path', { isTenantHost: true })).toBeNull();
    expect(deriveBaseFromHost('https://evil.com', { isTenantHost: true })).toBeNull();
    expect(deriveBaseFromHost(undefined, { isTenantHost: true })).toBeNull();
  });
});

describe('deriveRedirectUri — PR-3.1 derivedBase precedence', () => {
  it('validated derivedBase WINS over the env chain', () => {
    process.env['AUTH_PUBLIC_BASE_URL'] = 'http://localhost:4201';
    expect(deriveRedirectUri('platform', 'https://admin.aramo.ai')).toBe(
      'https://admin.aramo.ai/auth/platform/callback',
    );
  });

  it('null derivedBase (unvalidated host) falls back to the env chain', () => {
    process.env['AUTH_PUBLIC_BASE_URL'] = 'http://localhost:4201';
    expect(deriveRedirectUri('recruiter', null)).toBe('http://localhost:4201/auth/recruiter/callback');
  });
});

describe('derivePostLoginRedirect — PR-3.1 §3d.2', () => {
  it('validated host → derivedBase + AUTH_POST_LOGIN_PATH (default /)', () => {
    expect(derivePostLoginRedirect('https://admin.aramo.ai')).toBe('https://admin.aramo.ai/');
    process.env['AUTH_POST_LOGIN_PATH'] = '/tenants';
    expect(derivePostLoginRedirect('https://admin.aramo.ai')).toBe('https://admin.aramo.ai/tenants');
  });

  it('unvalidated host → legacy full-URL AUTH_POST_LOGIN_REDIRECT (existing behavior)', () => {
    process.env['AUTH_POST_LOGIN_REDIRECT'] = 'https://astre.aramo.ai/desk';
    expect(derivePostLoginRedirect(null)).toBe('https://astre.aramo.ai/desk');
  });

  it('neither → null (post_login_redirect_missing throw survives)', () => {
    expect(derivePostLoginRedirect(null)).toBeNull();
  });
});

describe('deriveSignoutRedirect — PR-3.1 §3d.3', () => {
  it('validated host → derivedBase + AUTH_SIGNOUT_PATH (default /)', () => {
    expect(deriveSignoutRedirect('https://admin.aramo.ai')).toBe('https://admin.aramo.ai/');
    process.env['AUTH_SIGNOUT_PATH'] = '/goodbye';
    expect(deriveSignoutRedirect('https://admin.aramo.ai')).toBe('https://admin.aramo.ai/goodbye');
  });

  it('unvalidated host → legacy AUTH_COGNITO_SIGNOUT_REDIRECT (registered, never the raw host)', () => {
    process.env['AUTH_COGNITO_SIGNOUT_REDIRECT'] = 'https://astre.aramo.ai/';
    expect(deriveSignoutRedirect(null)).toBe('https://astre.aramo.ai/');
  });

  it('neither → null (signout_redirect_missing throw survives)', () => {
    expect(deriveSignoutRedirect(null)).toBeNull();
  });
});
