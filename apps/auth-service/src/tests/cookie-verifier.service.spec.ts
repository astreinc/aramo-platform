import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, importPKCS8 } from 'jose';

import { CookieVerifierService } from '../app/auth/cookie-verifier.service.js';
import { JwtIssuerService } from '../app/auth/jwt-issuer.service.js';

import { generateTestKeyPair } from './test-keys.js';

const SUB = '01900000-0000-7000-8000-000000000001';
const TENANT = '01900000-0000-7000-8000-0000000000aa';

let saved: Partial<Record<string, string | undefined>> = {};
let privatePem: string;
let publicPem: string;

beforeAll(() => {
  saved = {
    AUTH_AUDIENCE: process.env['AUTH_AUDIENCE'],
    AUTH_PRIVATE_KEY: process.env['AUTH_PRIVATE_KEY'],
    AUTH_PUBLIC_KEY: process.env['AUTH_PUBLIC_KEY'],
  };
  ({ privatePem, publicPem } = generateTestKeyPair());
  process.env['AUTH_AUDIENCE'] = 'aramo-test-audience';
  process.env['AUTH_PRIVATE_KEY'] = privatePem;
  process.env['AUTH_PUBLIC_KEY'] = publicPem;
});

afterAll(() => {
  for (const k of ['AUTH_AUDIENCE', 'AUTH_PRIVATE_KEY', 'AUTH_PUBLIC_KEY']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('CookieVerifierService.verify', () => {
  // Test 24: round-trip with JwtIssuerService.
  it('accepts a JWT signed by JwtIssuerService (round-trip)', async () => {
    const issuer = new JwtIssuerService();
    const verifier = new CookieVerifierService();
    const jwt = await issuer.sign({
      sub: SUB,
      consumer_type: 'recruiter',
      tenant_id: TENANT,
      scopes: ['auth:session:read'],
    });
    const payload = await verifier.verify(jwt);
    expect(payload.sub).toBe(SUB);
    expect(payload.consumer_type).toBe('recruiter');
    expect(payload.tenant_id).toBe(TENANT);
    expect(payload.scopes).toEqual(['auth:session:read']);
  });

  // Test 25: rejects expired tokens.
  it('rejects expired tokens', async () => {
    const verifier = new CookieVerifierService();
    const key = await importPKCS8(privatePem, 'RS256');
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const expired = await new SignJWT({
      consumer_type: 'recruiter',
      tenant_id: TENANT,
      scopes: [],
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Aramo Core Auth')
      .setAudience('aramo-test-audience')
      .setSubject(SUB)
      .setIssuedAt(past)
      .setExpirationTime(past + 60)
      .sign(key);
    await expect(verifier.verify(expired)).rejects.toThrow();
  });

  // Test 26: rejects wrong-issuer tokens.
  it('rejects wrong-issuer tokens', async () => {
    const verifier = new CookieVerifierService();
    const key = await importPKCS8(privatePem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const wrongIss = await new SignJWT({
      consumer_type: 'recruiter',
      tenant_id: TENANT,
      scopes: [],
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer('Some Other Issuer')
      .setAudience('aramo-test-audience')
      .setSubject(SUB)
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(key);
    await expect(verifier.verify(wrongIss)).rejects.toThrow();
  });
});
