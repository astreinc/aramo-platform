import 'reflect-metadata';
import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';

import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { AramoError } from '@aramo/common';
import { EsignSenderConsumerGuard } from '@aramo/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SignAppleRevokeController } from '../app/me/apple/sign-apple-revoke.controller.js';
import {
  appleSiwaConfig,
  APPLE_REVOKE_STATE_TTL_MS,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  mintAppleRevokeState,
  safeReturnPath,
  SignAppleRevokeService,
} from '../app/me/apple/sign-apple-revoke.service.js';

// Apple Go-Live R-8 / W6 — deletion revokes Apple tokens, best effort: the code is exchanged at
// /auth/token with an ES256 client secret, then the refresh token is revoked; every failure still
// answers 202 (or redirects with apple_revoked=0); unset configuration makes no call; the
// web/Android callback binds the user by a signed, 10-minute state and never redirects off-site.

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const PUBLIC = createPublicKey(privateKey);
const USER = '11111111-1111-7111-8111-111111111111';
const auth: AuthContextType = { sub: USER, consumer_type: 'sign', actor_kind: 'user', tenant_id: '22222222-2222-7222-8222-222222222222', scopes: [], iat: 0, exp: 0 };

const ENV = {
  SIGN_APPLE_SIWA_TEAM_ID: 'TEAM123456',
  SIGN_APPLE_SIWA_KEY_ID: 'KEY1234567',
  SIGN_APPLE_SIWA_PRIVATE_KEY_B64: Buffer.from(PEM, 'utf8').toString('base64'),
  SIGN_APPLE_SIWA_SERVICES_ID: 'ai.aramo.sign.web',
  SIGN_APPLE_BUNDLE_ID: 'ai.aramo.sign',
  ARAMO_SIGN_BASE_URL: 'https://sign.aramo.ai',
};

interface Call {
  url: string;
  form: URLSearchParams;
}
let calls: Call[] = [];
let replies: Array<() => Response> = [];
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

function fakeRes() {
  const r = { status: 0, location: '' };
  return { r, res: { redirect: (status: number, url: string) => Object.assign(r, { status, location: url }) } as never };
}

function decodeJwt(jwt: string): { header: Record<string, unknown>; claims: Record<string, unknown>; valid: boolean } {
  const [h, c, s] = jwt.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    claims: JSON.parse(Buffer.from(c, 'base64url').toString('utf8')),
    valid: cryptoVerify('sha256', Buffer.from(`${h}.${c}`), { key: PUBLIC, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')),
  };
}

beforeEach(() => {
  calls = [];
  replies = [json(200, { access_token: 'at-x', refresh_token: 'rt-secret', id_token: 'id-x' }), () => new Response('', { status: 200 })];
  for (const k of Object.keys(ENV)) vi.stubEnv(k, '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string; signal?: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      calls.push({ url, form: new URLSearchParams(init.body) });
      const next = replies.shift();
      if (next === undefined) throw new Error('unexpected fetch');
      return next();
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Apple Go-Live R-8 — POST /v1/sign/me/apple/revoke', () => {
  it('is a signed-in route (session + sign consumer) answering 202', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, SignAppleRevokeController.prototype.revoke);
    expect(guards).toEqual([JwtAuthGuard, EsignSenderConsumerGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, SignAppleRevokeController.prototype.start)).toEqual([JwtAuthGuard, EsignSenderConsumerGuard]);
    expect(Reflect.getMetadata(GUARDS_METADATA, SignAppleRevokeController.prototype.callback)).toBeUndefined();
    expect(Reflect.getMetadata('__httpCode__', SignAppleRevokeController.prototype.revoke)).toBe(202);
  });

  it('ios: exchanges the code (client_id = bundle id, ES256 secret, no redirect_uri) then revokes the refresh token', async () => {
    stubEnv(ENV);
    const controller = new SignAppleRevokeController(new SignAppleRevokeService());
    await expect(controller.revoke({ authorization_code: 'code-abc', client: 'ios' })).resolves.toEqual({});

    expect(calls.map((c) => c.url)).toEqual([APPLE_TOKEN_URL, APPLE_REVOKE_URL]);
    const [token, revoke] = calls as [Call, Call];
    expect(token.form.get('grant_type')).toBe('authorization_code');
    expect(token.form.get('code')).toBe('code-abc');
    expect(token.form.get('client_id')).toBe('ai.aramo.sign');
    expect(token.form.has('redirect_uri')).toBe(false);
    const secret = decodeJwt(token.form.get('client_secret') ?? '');
    expect(secret.valid).toBe(true);
    expect(secret.header).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(secret.claims).toMatchObject({ iss: 'TEAM123456', sub: 'ai.aramo.sign', aud: 'https://appleid.apple.com' });
    expect((secret.claims['exp'] as number) > (secret.claims['iat'] as number)).toBe(true);

    expect(revoke.form.get('client_id')).toBe('ai.aramo.sign');
    expect(revoke.form.get('client_secret')).toBe(token.form.get('client_secret'));
    expect(revoke.form.get('token')).toBe('rt-secret');
    expect(revoke.form.get('token_type_hint')).toBe('refresh_token');
  });

  it('web: client_id = the Services ID and the code is exchanged with our redirect_uri', async () => {
    stubEnv(ENV);
    const svc = new SignAppleRevokeService();
    await expect(svc.revokeFromApp({ authorization_code: 'code-web', client: 'web' })).resolves.toBe('revoked');
    expect(calls[0]?.form.get('client_id')).toBe('ai.aramo.sign.web');
    expect(calls[0]?.form.get('redirect_uri')).toBe('https://sign.aramo.ai/v1/sign/me/apple/revoke/callback');
    expect(calls[1]?.form.get('client_id')).toBe('ai.aramo.sign.web');
    expect(decodeJwt(calls[0]?.form.get('client_secret') ?? '').claims['sub']).toBe('ai.aramo.sign.web');
  });

  it('an Apple error still answers 202 and never logs the code or a token', async () => {
    stubEnv(ENV);
    const logged: string[] = [];
    const capture = (m: unknown) => void logged.push(String(m));
    const svc = new SignAppleRevokeService();
    vi.spyOn((svc as unknown as { log: { warn: (m: unknown) => void } }).log, 'warn').mockImplementation(capture);
    vi.spyOn((svc as unknown as { log: { log: (m: unknown) => void } }).log, 'log').mockImplementation(capture);
    const controller = new SignAppleRevokeController(svc);

    replies = [json(400, { error: 'invalid_grant' })];
    await expect(controller.revoke({ authorization_code: 'code-bad', client: 'ios' })).resolves.toEqual({});
    expect(calls).toHaveLength(1);

    replies = [json(200, { refresh_token: 'rt-secret' }), json(500, { error: 'server' })];
    await expect(controller.revoke({ authorization_code: 'code-two', client: 'ios' })).resolves.toEqual({});

    replies = [() => { throw new Error('network down'); }];
    await expect(controller.revoke({ authorization_code: 'code-three', client: 'ios' })).resolves.toEqual({});

    expect(logged).toEqual([
      'apple revoke outcome=token_exchange_failed client=ios status=400',
      'apple revoke outcome=revoke_failed client=ios status=500',
      'apple revoke outcome=token_exchange_error client=ios',
    ]);
    expect(logged.join(' ')).not.toMatch(/code-|rt-secret|PRIVATE/);
  });

  it('unset configuration: 202, an "apple revoke unavailable" log line, no call', async () => {
    const svc = new SignAppleRevokeService();
    const logSpy = vi.spyOn((svc as unknown as { log: { log: (m: unknown) => void } }).log, 'log').mockImplementation(() => undefined);
    await expect(new SignAppleRevokeController(svc).revoke({ authorization_code: 'code-abc', client: 'ios' })).resolves.toEqual({});
    expect(calls).toHaveLength(0);
    expect(logSpy).toHaveBeenCalledWith('apple revoke unavailable');
    expect(appleSiwaConfig()).toBeNull();

    // Configured, but the iOS bundle id is missing: still no call.
    stubEnv({ ...ENV, SIGN_APPLE_BUNDLE_ID: '' });
    await expect(svc.revokeFromApp({ authorization_code: 'code-abc', client: 'ios' })).resolves.toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it('malformed input (missing code, unknown client) is still 202 with no call', async () => {
    stubEnv(ENV);
    const svc = new SignAppleRevokeService();
    vi.spyOn((svc as unknown as { log: { warn: (m: unknown) => void } }).log, 'warn').mockImplementation(() => undefined);
    const c = new SignAppleRevokeController(svc);
    await expect(c.revoke({ client: 'ios' })).resolves.toEqual({});
    await expect(c.revoke({ authorization_code: 'x', client: 'windows' })).resolves.toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe('Apple Go-Live R-8 — web/Android redirect (start + callback)', () => {
  it('start redirects to Apple authorize with the Services ID, form_post, our redirect_uri and a signed state', () => {
    stubEnv(ENV);
    const { r, res } = fakeRes();
    new SignAppleRevokeController(new SignAppleRevokeService()).start(auth, '/settings/account?tab=delete', undefined, 'req-1', res);
    expect(r.status).toBe(302);
    const url = new URL(r.location);
    expect(`${url.origin}${url.pathname}`).toBe('https://appleid.apple.com/auth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ai.aramo.sign.web');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('response_mode')).toBe('form_post');
    expect(url.searchParams.get('redirect_uri')).toBe('https://sign.aramo.ai/v1/sign/me/apple/revoke/callback');
    const state = url.searchParams.get('state') ?? '';
    const claims = JSON.parse(Buffer.from(state.split('.')[0] ?? '', 'base64url').toString('utf8'));
    expect(claims).toMatchObject({ user_id: USER, return: '/settings/account?tab=delete' });
    expect(typeof claims.nonce).toBe('string');
  });

  it('start with format=json returns the authorize URL for the app to open (Android Bearer path)', () => {
    stubEnv(ENV);
    const out: { status: number; body: unknown } = { status: 0, body: null };
    const res = {
      status(code: number) { out.status = code; return this; },
      json(body: unknown) { out.body = body; },
      redirect: () => { throw new Error('must not redirect'); },
    } as never;
    new SignAppleRevokeController(new SignAppleRevokeService()).start(auth, '/settings', 'json', 'req-1', res);
    expect(out.status).toBe(200);
    const url = new URL((out.body as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe('https://appleid.apple.com/auth/authorize');
  });

  it('start refuses an open redirect (400 invalid_return)', () => {
    stubEnv(ENV);
    const c = new SignAppleRevokeController(new SignAppleRevokeService());
    for (const bad of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'settings', '/a#frag', '/a\nb', undefined]) {
      const { res } = fakeRes();
      try {
        c.start(auth, bad, undefined, 'req-1', res);
        expect.fail(`accepted ${String(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(AramoError);
        expect((e as AramoError).statusCode).toBe(400);
      }
    }
    expect(safeReturnPath('/settings')).toBe('/settings');
  });

  it('start with the feature unconfigured returns straight to <return>?apple_revoked=0', () => {
    const { r, res } = fakeRes();
    const svc = new SignAppleRevokeService();
    vi.spyOn((svc as unknown as { log: { log: (m: unknown) => void } }).log, 'log').mockImplementation(() => undefined);
    new SignAppleRevokeController(svc).start(auth, '/settings', undefined, 'req-1', res);
    expect(r).toEqual({ status: 302, location: '/settings?apple_revoked=0' });
  });

  it('callback: a valid state → exchange (web client, redirect_uri) + revoke → 302 <return>&apple_revoked=1', async () => {
    stubEnv(ENV);
    const config = appleSiwaConfig();
    if (config === null) throw new Error('config');
    const state = mintAppleRevokeState(config, USER, '/settings?tab=delete');
    const { r, res } = fakeRes();
    await new SignAppleRevokeController(new SignAppleRevokeService()).callback({ code: 'code-cb', state }, res);
    expect(r).toEqual({ status: 302, location: '/settings?tab=delete&apple_revoked=1' });
    expect(calls.map((c) => c.url)).toEqual([APPLE_TOKEN_URL, APPLE_REVOKE_URL]);
    expect(calls[0]?.form.get('client_id')).toBe('ai.aramo.sign.web');
    expect(calls[0]?.form.get('redirect_uri')).toBe('https://sign.aramo.ai/v1/sign/me/apple/revoke/callback');
  });

  it('callback: Apple failure → apple_revoked=0; user cancelled (no code) → apple_revoked=0 with no call', async () => {
    stubEnv(ENV);
    const config = appleSiwaConfig();
    if (config === null) throw new Error('config');
    const svc = new SignAppleRevokeService();
    vi.spyOn((svc as unknown as { log: { warn: (m: unknown) => void } }).log, 'warn').mockImplementation(() => undefined);
    const c = new SignAppleRevokeController(svc);
    replies = [json(400, { error: 'invalid_grant' })];
    const a = fakeRes();
    await c.callback({ code: 'code-cb', state: mintAppleRevokeState(config, USER, '/settings') }, a.res);
    expect(a.r).toEqual({ status: 302, location: '/settings?apple_revoked=0' });
    const b = fakeRes();
    await c.callback({ state: mintAppleRevokeState(config, USER, '/settings') }, b.res);
    expect(b.r).toEqual({ status: 302, location: '/settings?apple_revoked=0' });
    expect(calls).toHaveLength(1);
  });

  it('callback: a bad or tampered state goes to / with apple_revoked=0 and makes no call', async () => {
    stubEnv(ENV);
    const config = appleSiwaConfig();
    if (config === null) throw new Error('config');
    const svc = new SignAppleRevokeService();
    vi.spyOn((svc as unknown as { log: { warn: (m: unknown) => void } }).log, 'warn').mockImplementation(() => undefined);
    const c = new SignAppleRevokeController(svc);
    const good = mintAppleRevokeState(config, USER, '/settings');
    const [body, mac] = good.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ user_id: USER, return: 'https://evil.example', exp: Date.now() + 60_000, nonce: 'n' })).toString('base64url');
    for (const state of [undefined, '', 'garbage', `${forged}.${mac}`, `${body}.${mac.slice(0, -2)}AA`, `${body}x.${mac}`]) {
      const { r, res } = fakeRes();
      await c.callback({ code: 'code-cb', state }, res);
      expect(r).toEqual({ status: 302, location: '/?apple_revoked=0' });
    }
    expect(calls).toHaveLength(0);
  });

  it('callback: an expired state (older than 10 minutes) is refused', async () => {
    stubEnv(ENV);
    const config = appleSiwaConfig();
    if (config === null) throw new Error('config');
    const svc = new SignAppleRevokeService();
    vi.spyOn((svc as unknown as { log: { warn: (m: unknown) => void } }).log, 'warn').mockImplementation(() => undefined);
    const minted = new Date(Date.now() - APPLE_REVOKE_STATE_TTL_MS - 1000);
    const { r, res } = fakeRes();
    await new SignAppleRevokeController(svc).callback({ code: 'code-cb', state: mintAppleRevokeState(config, USER, '/settings', minted) }, res);
    expect(r).toEqual({ status: 302, location: '/?apple_revoked=0' });
    expect(calls).toHaveLength(0);
  });

  it('a state signed under another Sign in with Apple key does not verify', async () => {
    stubEnv(ENV);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const config = appleSiwaConfig();
    if (config === null) throw new Error('config');
    const foreign = mintAppleRevokeState({ ...config, private_key_pem: other }, USER, '/settings');
    const svc = new SignAppleRevokeService();
    vi.spyOn((svc as unknown as { log: { warn: (m: unknown) => void } }).log, 'warn').mockImplementation(() => undefined);
    const { r, res } = fakeRes();
    await new SignAppleRevokeController(svc).callback({ code: 'code-cb', state: foreign }, res);
    expect(r.location).toBe('/?apple_revoked=0');
    expect(calls).toHaveLength(0);
  });
});
