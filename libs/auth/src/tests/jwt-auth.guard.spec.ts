import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  cookies: Record<string, string>;
  requestId?: string;
  authContext?: unknown;
  header(name: string): string | undefined;
}

function makeRequest(
  headers: Record<string, string>,
  cookies: Record<string, string> = {},
): MutableRequest {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    headers: lower,
    cookies,
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
    actor_kind: 'user',
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
      actor_kind: 'user',
      tenant_id: '00000000-0000-0000-0000-000000000001',
      scopes: ['consent:write'],
    });
  });

  // PR-8.0b §9 case 1: cookie-only success — no Authorization header, valid
  // cookie token populates authContext.
  it('accepts a valid token from the aramo_access_token cookie when no Authorization header is present', async () => {
    const token = await makeToken({ sub: 'cookie-sub' });
    const request = makeRequest({}, { aramo_access_token: token });
    const result = await guard.canActivate(makeContext(request));
    expect(result).toBe(true);
    expect(request.authContext).toMatchObject({
      sub: 'cookie-sub',
      consumer_type: 'recruiter',
      actor_kind: 'user',
    });
  });

  // PR-8.0b §9 case 2: bearer precedence — when both bearer and cookie are
  // present, the bearer token wins.
  it('prefers the Bearer header over the cookie when both are present', async () => {
    const bearerToken = await makeToken({ sub: 'bearer-sub' });
    const cookieToken = await makeToken({ sub: 'cookie-sub' });
    const request = makeRequest(
      { Authorization: `Bearer ${bearerToken}` },
      { aramo_access_token: cookieToken },
    );
    const result = await guard.canActivate(makeContext(request));
    expect(result).toBe(true);
    expect(request.authContext).toMatchObject({ sub: 'bearer-sub' });
  });

  // PR-8.0b §9 case 3: bearer + empty cookie — bearer succeeds; empty cookie
  // does not poison the request.
  it('accepts a Bearer token when the cookie is present but empty', async () => {
    const token = await makeToken({ sub: 'bearer-sub' });
    const request = makeRequest(
      { Authorization: `Bearer ${token}` },
      { aramo_access_token: '' },
    );
    const result = await guard.canActivate(makeContext(request));
    expect(result).toBe(true);
    expect(request.authContext).toMatchObject({ sub: 'bearer-sub' });
  });

  // PR-8.0b §9 case 4: empty cookie failure — no header, empty cookie is
  // treated as absent → AUTH_REQUIRED.
  it('throws AUTH_REQUIRED when no header is present and the cookie is empty', async () => {
    const request = makeRequest({}, { aramo_access_token: '' });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  });

  // PR-8.0b §9 case 5: malformed Authorization header — AUTH_REQUIRED with NO
  // cookie fallback even when a valid cookie is present.
  it('throws AUTH_REQUIRED for a malformed Authorization header and does not fall back to a valid cookie', async () => {
    const cookieToken = await makeToken({ sub: 'cookie-sub' });
    const request = makeRequest(
      { Authorization: 'Basic abc' },
      { aramo_access_token: cookieToken },
    );
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
    expect(request.authContext).toBeUndefined();
  });

  // PR-8.0b §9 case 6: invalid cookie token — no header, garbage cookie value
  // fails verification with INVALID_TOKEN.
  it('throws INVALID_TOKEN when the cookie value is not a valid JWT', async () => {
    const request = makeRequest({}, { aramo_access_token: 'not-a-jwt' });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });

  // PR-8.0b §9 case 7: missing actor_kind claim → INVALID_TOKEN.
  it('throws INVALID_TOKEN when the actor_kind claim is missing', async () => {
    const token = await makeToken({ actor_kind: undefined });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });

  // PR-8.0b §9 case 8: actor_kind not in the closed set → INVALID_TOKEN.
  it('throws INVALID_TOKEN when actor_kind is outside the closed set', async () => {
    const token = await makeToken({ actor_kind: 'robot' });
    const request = makeRequest({ Authorization: `Bearer ${token}` });
    await expect(guard.canActivate(makeContext(request))).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });

  // PR-8.0b §9 case 9 (Path-B filesystem-read drift detection, HC.16):
  // the cookie name `aramo_access_token` is duplicated between the guard
  // (this library) and the auth-service controller. This test reads the
  // controller source via filesystem and asserts byte-equality of the
  // literal. Failure means the two literals have drifted; HALT and surface
  // — do NOT modify either literal to "fix" this test.
  it('keeps the cookie-name literal byte-equal between libs/auth and apps/auth-service', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const authServiceController = resolve(
      here,
      '../../../../apps/auth-service/src/app/auth/auth.controller.ts',
    );
    const source = await readFile(authServiceController, 'utf8');
    expect(source).toContain("'aramo_access_token'");
  });
});
