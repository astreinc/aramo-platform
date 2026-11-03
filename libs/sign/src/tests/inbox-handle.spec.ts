import { createCipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { INBOX_HANDLE_KEY_ENV, INBOX_HANDLE_TTL_MS, inboxHandleKey, isUuid, mintInboxHandle, openInboxHandle } from '../lib/inbox-handle.js';

// Aramo Sign W2 §A3.4 (Lead C3) — the discovered-item handle: AES-256-GCM over
// {v, signer_id, user_id, iat, exp}; 30 minutes; user-bound; fail closed without the key.

const KEY = randomBytes(32);
const USER = '11111111-1111-7111-8111-111111111111';
const OTHER = '22222222-2222-7222-8222-222222222222';
const SIGNER = '33333333-3333-7333-8333-333333333333';
const NOW = new Date('2026-11-03T10:00:00.000Z');

describe('inbox handle (C3)', () => {
  it('round-trips the claims; iat/exp are 30 minutes apart; the token reveals no id', () => {
    const h = mintInboxHandle(KEY, { signer_id: SIGNER, user_id: USER }, NOW);
    expect(h).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(h).not.toContain(SIGNER);
    expect(Buffer.from(h, 'base64url').toString('latin1')).not.toContain(SIGNER);
    const c = openInboxHandle(KEY, h, USER, NOW);
    expect(c).toEqual({ v: 1, signer_id: SIGNER, user_id: USER, iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + INBOX_HANDLE_TTL_MS / 1000 });
    expect(INBOX_HANDLE_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('two handles for the same row differ (random IV)', () => {
    expect(mintInboxHandle(KEY, { signer_id: SIGNER, user_id: USER }, NOW)).not.toBe(mintInboxHandle(KEY, { signer_id: SIGNER, user_id: USER }, NOW));
  });

  it('row 21: any single changed character fails (authenticated, canonical encoding only)', () => {
    const h = mintInboxHandle(KEY, { signer_id: SIGNER, user_id: USER }, NOW);
    for (let i = 0; i < h.length; i += 1) {
      for (const c of ['A', 'B', '-', '_', 'z']) {
        if (h[i] === c) continue;
        expect(openInboxHandle(KEY, h.slice(0, i) + c + h.slice(i + 1), USER, NOW)).toBeNull();
      }
    }
    expect(openInboxHandle(KEY, `${h}A`, USER, NOW)).toBeNull();
    expect(openInboxHandle(KEY, h.slice(0, -1), USER, NOW)).toBeNull();
  });

  it('row 22: refused at and after exp, accepted just before', () => {
    const h = mintInboxHandle(KEY, { signer_id: SIGNER, user_id: USER }, NOW);
    expect(openInboxHandle(KEY, h, USER, new Date(NOW.getTime() + INBOX_HANDLE_TTL_MS - 1000))).not.toBeNull();
    expect(openInboxHandle(KEY, h, USER, new Date(NOW.getTime() + INBOX_HANDLE_TTL_MS))).toBeNull();
    expect(openInboxHandle(KEY, h, USER, new Date(NOW.getTime() + 2 * INBOX_HANDLE_TTL_MS))).toBeNull();
  });

  it('row 23: another user cannot redeem it', () => {
    const h = mintInboxHandle(KEY, { signer_id: SIGNER, user_id: USER }, NOW);
    expect(openInboxHandle(KEY, h, OTHER, NOW)).toBeNull();
  });

  it('row 15: another key, garbage, empty or oversized input → null', () => {
    const h = mintInboxHandle(randomBytes(32), { signer_id: SIGNER, user_id: USER }, NOW);
    expect(openInboxHandle(KEY, h, USER, NOW)).toBeNull();
    for (const bad of ['', 'not-a-handle', 'a.b.c', '%%%', 'A'.repeat(600)]) expect(openInboxHandle(KEY, bad, USER, NOW)).toBeNull();
  });

  it('a correctly encrypted payload with the wrong shape is refused (version, ids, lifetime)', () => {
    const forge = (claims: unknown): string => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', KEY, iv);
      const ct = Buffer.concat([c.update(JSON.stringify(claims), 'utf8'), c.final()]);
      return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64url');
    };
    const iat = NOW.getTime() / 1000;
    const good = { v: 1, signer_id: SIGNER, user_id: USER, iat, exp: iat + 1800 };
    expect(openInboxHandle(KEY, forge(good), USER, NOW)).not.toBeNull();
    expect(openInboxHandle(KEY, forge({ ...good, v: 2 }), USER, NOW)).toBeNull();
    expect(openInboxHandle(KEY, forge({ ...good, signer_id: 'x' }), USER, NOW)).toBeNull();
    expect(openInboxHandle(KEY, forge({ ...good, exp: iat + 86_400 }), USER, NOW)).toBeNull();
    expect(openInboxHandle(KEY, forge('str'), USER, NOW)).toBeNull();
  });

  it('row 26: the key is 32 bytes base64 with no default; anything else is OFF', () => {
    expect(inboxHandleKey({})).toBeNull();
    expect(inboxHandleKey({ [INBOX_HANDLE_KEY_ENV]: '' })).toBeNull();
    expect(inboxHandleKey({ [INBOX_HANDLE_KEY_ENV]: randomBytes(16).toString('base64') })).toBeNull();
    expect(inboxHandleKey({ [INBOX_HANDLE_KEY_ENV]: randomBytes(33).toString('base64') })).toBeNull();
    expect(inboxHandleKey({ [INBOX_HANDLE_KEY_ENV]: KEY.toString('base64') })?.equals(KEY)).toBe(true);
  });

  it('isUuid separates binding ids from handles', () => {
    expect(isUuid(SIGNER)).toBe(true);
    expect(isUuid(mintInboxHandle(KEY, { signer_id: SIGNER, user_id: USER }, NOW))).toBe(false);
  });
});
