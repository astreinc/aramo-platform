import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JwksService } from '../app/auth/jwks.service.js';

import { generateTestKeyPair } from './test-keys.js';

let savedPriv: string | undefined;
let privatePem: string;

beforeAll(() => {
  savedPriv = process.env['AUTH_PRIVATE_KEY'];
  ({ privatePem } = generateTestKeyPair());
  process.env['AUTH_PRIVATE_KEY'] = privatePem;
});

afterAll(() => {
  if (savedPriv === undefined) delete process.env['AUTH_PRIVATE_KEY'];
  else process.env['AUTH_PRIVATE_KEY'] = savedPriv;
});

describe('JwksService.getJwks', () => {
  // Test 27: produces a JWKS with single key, use=sig, alg=RS256, kid matching SHA-256 fingerprint.
  it('produces a single-key JWKS with use=sig, alg=RS256, kid = SHA-256 fingerprint', async () => {
    const svc = new JwksService();
    const doc = await svc.getJwks();
    expect(doc.keys).toHaveLength(1);
    const k = doc.keys[0]!;
    expect(k.kty).toBe('RSA');
    expect(k.use).toBe('sig');
    expect(k.alg).toBe('RS256');
    expect(typeof k.n).toBe('string');
    expect(typeof k.e).toBe('string');

    // Recompute the expected kid independently.
    const priv = createPrivateKey({ key: privatePem, format: 'pem' });
    const pub = createPublicKey(priv);
    const spkiDer = pub.export({ format: 'der', type: 'spki' });
    const expectedKid = createHash('sha256').update(spkiDer).digest('base64url');
    expect(k.kid).toBe(expectedKid);
  });
});
