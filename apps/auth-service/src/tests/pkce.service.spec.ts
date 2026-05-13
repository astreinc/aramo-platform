import { randomBytes } from 'node:crypto';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PkceService } from '../app/auth/pkce.service.js';

const KEY_B64URL = randomBytes(32).toString('base64url');

beforeAll(() => {
  process.env['AUTH_PKCE_STATE_KEY'] = KEY_B64URL;
});

describe('PkceService.generate', () => {
  // Test 17: verifier 43-128 chars; challenge = base64url(SHA-256(verifier)); state random.
  it('produces an RFC-7636 verifier (43-128 chars) and S256 challenge + random state', () => {
    const svc = new PkceService();
    const out = svc.generate();
    expect(out.verifier.length).toBeGreaterThanOrEqual(43);
    expect(out.verifier.length).toBeLessThanOrEqual(128);
    expect(out.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(out.state).toMatch(/^[A-Za-z0-9_-]+$/);

    // Verify challenge derivation.
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const expectedChallenge = createHash('sha256').update(out.verifier).digest('base64url');
    expect(out.challenge).toBe(expectedChallenge);
  });
});

describe('PkceService.encryptState', () => {
  // Test 18: round-trip.
  it('decrypt(encrypt(x)) === x', () => {
    const svc = new PkceService();
    const payload = {
      verifier: 'abc',
      state: 'state-1',
      consumer: 'recruiter',
      issued_at: 1_700_000_000,
    };
    const ct = svc.encryptState(payload);
    const back = svc.decryptState(ct);
    expect(back).toEqual(payload);
  });

  // Test 19: different ciphertext for same plaintext (IV uniqueness).
  it('produces different ciphertext for repeated encryptions of the same payload', () => {
    const svc = new PkceService();
    const payload = {
      verifier: 'abc',
      state: 's',
      consumer: 'recruiter',
      issued_at: 1_700_000_000,
    };
    const a = svc.encryptState(payload);
    const b = svc.encryptState(payload);
    expect(a).not.toBe(b);
  });

  it('rejects tampered ciphertext (auth tag mismatch)', () => {
    const svc = new PkceService();
    const ct = svc.encryptState({
      verifier: 'v',
      state: 's',
      consumer: 'recruiter',
      issued_at: 1,
    });
    const tampered = ct.slice(0, ct.length - 1) + (ct.endsWith('A') ? 'B' : 'A');
    expect(() => svc.decryptState(tampered)).toThrow(/pkce_state_decrypt_failed/);
  });
});

afterEach(() => {
  // No teardown needed; env stays set.
});
