import { describe, expect, it } from 'vitest';

import {
  generatePortalLoginToken,
  hashPortalLoginToken,
  portalLoginExpiresAt,
  PORTAL_LOGIN_TTL_MS,
} from '../index.js';

// Portal P1 — the passwordless login-token pure util (TR-3 conventions verbatim,
// 15-minute TTL).

describe('portal-login-token util', () => {
  it('generates a fresh raw + its sha256.base64url hash; hash matches the standalone hasher', () => {
    const { raw, hash } = generatePortalLoginToken();
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(hash).toBe(hashPortalLoginToken(raw));
  });

  it('the raw token is high-entropy and unique across calls (the hash never repeats)', () => {
    const a = generatePortalLoginToken();
    const b = generatePortalLoginToken();
    expect(a.raw).not.toBe(b.raw);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hashing is deterministic — the same raw always yields the same hash', () => {
    const { raw, hash } = generatePortalLoginToken();
    expect(hashPortalLoginToken(raw)).toBe(hash);
  });

  it('the TTL is 15 minutes from now (the app-side window)', () => {
    expect(PORTAL_LOGIN_TTL_MS).toBe(15 * 60 * 1000);
    const now = new Date('2026-07-14T00:00:00.000Z');
    expect(portalLoginExpiresAt(now).toISOString()).toBe('2026-07-14T00:15:00.000Z');
  });
});
