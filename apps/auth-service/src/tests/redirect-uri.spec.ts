import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveRedirectUri } from '../app/auth/redirect-uri.js';

// Increment-1 Amendment v1.2 (Workstream D) — per-consumer redirect_uri
// derivation. The load-bearing invariant: the callback URL's consumer segment
// equals the login-path consumer, for EVERY consumer — so the login-time and
// callback-time consumers can no longer diverge (the shared-env bug this
// replaces). Also proves: AUTH_PUBLIC_BASE_URL precedence, the deprecation
// fallback to the legacy env's origin, trailing-slash normalization, and the
// fail-closed null when neither env is set.

const PUBLIC = 'AUTH_PUBLIC_BASE_URL';
const LEGACY = 'AUTH_COGNITO_REDIRECT_URI';

describe('deriveRedirectUri (Amendment v1.2 Workstream D)', () => {
  let savedPublic: string | undefined;
  let savedLegacy: string | undefined;

  beforeEach(() => {
    savedPublic = process.env[PUBLIC];
    savedLegacy = process.env[LEGACY];
    delete process.env[PUBLIC];
    delete process.env[LEGACY];
  });

  afterEach(() => {
    if (savedPublic === undefined) delete process.env[PUBLIC];
    else process.env[PUBLIC] = savedPublic;
    if (savedLegacy === undefined) delete process.env[LEGACY];
    else process.env[LEGACY] = savedLegacy;
  });

  it('derives a per-consumer callback path from AUTH_PUBLIC_BASE_URL — login-path consumer == redirect_uri consumer', () => {
    process.env[PUBLIC] = 'http://localhost:4201';
    expect(deriveRedirectUri('platform')).toBe(
      'http://localhost:4201/auth/platform/callback',
    );
    expect(deriveRedirectUri('recruiter')).toBe(
      'http://localhost:4201/auth/recruiter/callback',
    );
    expect(deriveRedirectUri('portal')).toBe(
      'http://localhost:4201/auth/portal/callback',
    );
    expect(deriveRedirectUri('ingestion')).toBe(
      'http://localhost:4201/auth/ingestion/callback',
    );
  });

  it('normalizes a trailing slash on the base', () => {
    process.env[PUBLIC] = 'http://localhost:4201/';
    expect(deriveRedirectUri('platform')).toBe(
      'http://localhost:4201/auth/platform/callback',
    );
  });

  it('deprecation fallback: derives the ORIGIN of legacy AUTH_COGNITO_REDIRECT_URI when AUTH_PUBLIC_BASE_URL is unset', () => {
    // The legacy value carried a full callback path for ONE consumer; the origin
    // is re-derived per consumer, so a recruiter-shaped legacy value still yields
    // the correct platform callback.
    process.env[LEGACY] = 'https://astre.aramo.ai/auth/recruiter/callback';
    expect(deriveRedirectUri('recruiter')).toBe(
      'https://astre.aramo.ai/auth/recruiter/callback',
    );
    expect(deriveRedirectUri('platform')).toBe(
      'https://astre.aramo.ai/auth/platform/callback',
    );
  });

  it('AUTH_PUBLIC_BASE_URL takes precedence over the legacy env', () => {
    process.env[PUBLIC] = 'http://localhost:4201';
    process.env[LEGACY] = 'https://legacy.example/auth/recruiter/callback';
    expect(deriveRedirectUri('platform')).toBe(
      'http://localhost:4201/auth/platform/callback',
    );
  });

  it('returns null (fail-closed → caller throws) when neither env is set', () => {
    expect(deriveRedirectUri('platform')).toBeNull();
  });
});
