import { ExecutionContext } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  exportSPKI,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type KeyObject,
} from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JwtAuthGuard } from '../lib/jwt-auth.guard.js';

type SignKey = CryptoKey | KeyObject;

const ISSUER = 'Aramo Core Auth';
const AUDIENCE = 'aramo-test';
const ALG = 'RS256';

interface MutableRequest {
  headers: Record<string, string>;
  requestId?: string;
  authContext?: unknown;
  header(name: string): string | undefined;
}

function makeRequest(headers: Record<string, string>): MutableRequest {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    headers: lower,
    requestId: 'test-req',
    header(name: string): string | undefined {
      return lower[name.toLowerCase()];
    },
  };
}

function makeContext(request: MutableRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
    }),
  } as unknown as ExecutionContext;
}

interface KeyPair {
  publicPem: string;
  privateKey: SignKey;
}

let keyPair: KeyPair;

beforeAll(async () => {
  const kp = await generateKeyPair(ALG);
  keyPair = {
    publicPem: await exportSPKI(kp.publicKey as never),
    privateKey: kp.privateKey as SignKey,
  };
});

async function makeToken(
  overrides: Record<string, unknown> = {},
  options: { issuer?: string; audience?: string; expiresIn?: string } = {},
): Promise<string> {
  const claims = {
    sub: 'user-1',
    consumer_type: 'recruiter',
    tenant_id: '00000000-0000-0000-0000-000000000001',
    scopes: ['consent:write'],
    ...overrides,
  };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? AUDIENCE)
    .setExpirationTime(options.expiresIn ?? '1h')
    .sign(keyPair.privateKey);
}

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    guard = new JwtAuthGuard();
    process.env['AUTH_PUBLIC_KEY'] = keyPair.publicPem;
    process.env['AUTH_AUDIENCE'] = AUDIENCE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws AUTH_REQUIRED when Authorization header is missing', async () => {
    const request = makeRequest({});
    await expect(guard.canActivate(makeContext(request))).rejects.toBeInstanceOf(
      AramoError,
    );
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  });

  it('throws AUTH_REQUIRED when Authorization header is not Bearer', async () => {
    const request = makeRequest({ Authorization: 'Basic abc' });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('throws INVALID_TOKEN for malformed token', async () => {
    const request = makeRequest({ Authorization: 'Bearer not-a-jwt' });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });

  it('throws INVALID_TOKEN when issuer is wrong', async () => {
    const token = await makeToken({}, { issuer: 'Some Other Issuer' });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('throws INVALID_TOKEN when audience is wrong', async () => {
    const token = await makeToken({}, { audience: 'wrong-aud' });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('throws INVALID_TOKEN when token is expired', async () => {
    const token = await makeToken({}, { expiresIn: '-1m' });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('throws INVALID_TOKEN when tenant_id claim is missing', async () => {
    const token = await makeToken({ tenant_id: undefined });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('throws INVALID_TOKEN when scopes claim is missing', async () => {
    const token = await makeToken({ scopes: undefined });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('throws INVALID_TOKEN when consumer_type is not in the closed set', async () => {
    const token = await makeToken({ consumer_type: 'admin' });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('throws INVALID_TOKEN when env is not configured', async () => {
    delete process.env['AUTH_PUBLIC_KEY'];
    const token = await makeToken();
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
    });
  });

  it('populates request.authContext on a valid token', async () => {
    const token = await makeToken();
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    const result = await guard.canActivate(makeContext(request));
    expect(result).toBe(true);
    expect(request.authContext).toMatchObject({
      sub: 'user-1',
      consumer_type: 'recruiter',
      tenant_id: '00000000-0000-0000-0000-000000000001',
      scopes: ['consent:write'],
    });
  });
});
