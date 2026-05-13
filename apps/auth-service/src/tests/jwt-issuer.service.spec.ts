import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt, decodeProtectedHeader } from 'jose';

import { ISSUER, JwtIssuerService } from '../app/auth/jwt-issuer.service.js';

import { generateTestKeyPair } from './test-keys.js';

const SUB = '01900000-0000-7000-8000-000000000001';
const TENANT = '01900000-0000-7000-8000-0000000000aa';

let savedAudience: string | undefined;
let savedPriv: string | undefined;

beforeAll(() => {
  savedAudience = process.env['AUTH_AUDIENCE'];
  savedPriv = process.env['AUTH_PRIVATE_KEY'];
  const { privatePem } = generateTestKeyPair();
  process.env['AUTH_AUDIENCE'] = 'aramo-test-audience';
  process.env['AUTH_PRIVATE_KEY'] = privatePem;
});

afterAll(() => {
  if (savedAudience === undefined) delete process.env['AUTH_AUDIENCE'];
  else process.env['AUTH_AUDIENCE'] = savedAudience;
  if (savedPriv === undefined) delete process.env['AUTH_PRIVATE_KEY'];
  else process.env['AUTH_PRIVATE_KEY'] = savedPriv;
});

describe('JwtIssuerService.sign', () => {
  // Test 21: produces a JWT with all 9 required claims + kid header.
  it('produces a JWT carrying all 9 required claims and kid header', async () => {
    const svc = new JwtIssuerService();
    const jwt = await svc.sign({
      sub: SUB,
      consumer_type: 'recruiter',
      tenant_id: TENANT,
      scopes: ['auth:session:read'],
    });
    const payload = decodeJwt(jwt);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe('aramo-test-audience');
    expect(payload.sub).toBe(SUB);
    expect(payload['actor_kind']).toBe('user');
    expect(payload['consumer_type']).toBe('recruiter');
    expect(payload['tenant_id']).toBe(TENANT);
    expect(payload['scopes']).toEqual(['auth:session:read']);
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    // exp = iat + 900 (15 minutes)
    expect(payload.exp! - payload.iat!).toBe(900);

    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(typeof header.kid).toBe('string');
    expect((header.kid as string).length).toBeGreaterThan(0);
  });

  // Test 22: byte-exact issuer literal matches libs/auth's ISSUER constant.
  // The verifier and issuer must agree byte-for-byte; drift would cause every
  // verification to fail.
  it('issuer literal "Aramo Core Auth" matches libs/auth ISSUER constant byte-for-byte', () => {
    // Verify against the actual file content of libs/auth/src/lib/jwt-auth.guard.ts
    // so this is not a self-referential parity check.
    const here = resolve(__dirname);
    const guardPath = resolve(
      here,
      '..',
      '..',
      '..',
      '..',
      'libs',
      'auth',
      'src',
      'lib',
      'jwt-auth.guard.ts',
    );
    const guardSrc = readFileSync(guardPath, 'utf8');
    const m = /const ISSUER = ['"]([^'"]+)['"]/.exec(guardSrc);
    expect(m).not.toBeNull();
    const verifierIssuer = m![1]!;
    expect(ISSUER).toBe(verifierIssuer);
    expect(ISSUER).toBe('Aramo Core Auth');
  });

  // Test 23: alg = RS256 (covered by test 21 header check; explicit assertion).
  it('signs with RS256 algorithm', async () => {
    const svc = new JwtIssuerService();
    const jwt = await svc.sign({
      sub: SUB,
      consumer_type: 'portal',
      tenant_id: TENANT,
      scopes: [],
    });
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');
  });
});
