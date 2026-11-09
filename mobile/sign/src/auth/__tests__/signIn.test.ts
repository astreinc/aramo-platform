import { ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import {
  NATIVE_FALLBACK_REDIRECT_URI,
  NATIVE_REDIRECT_URI,
  NATIVE_SIGNOUT_REDIRECT_URI,
} from '../../config/env';
import { buildLogoutUrl } from '../authorize';
import { fakeJwt, memoryKv, nodeCrypto, recordingFetch } from '../../testing/fakes';
import { base64UrlEncode, utf8Encode } from '../../util/bytes';
import { deliverCallback } from '../callbackBus';
import { createNativeAuthApi } from '../nativeAuthApi';
import { codeChallengeS256 } from '../pkce';
import { SessionManager } from '../session';
import {
  appleSignupIdentity,
  linkProvider,
  signInWithProvider,
  type AuthSessionResult,
  type SignInDeps,
} from '../signIn';
import { SECURE_KEYS } from '../secureKeyValue';
import { createTokenStore } from '../tokenStore';

const ENV = {
  cognitoDomain: 'auth.example.aramo.ai',
  nativeClientId: 'nativeclient123',
  androidRedirect: 'https' as const,
};
const DEVICE = {
  installation_id: '11111111-2222-4333-8444-555555555555',
  platform: 'ios' as const,
  app_version: '1.0.0',
};

function param(url: string, name: string): string {
  const pair = url
    .split('?')[1]!
    .split('&')
    .find((p) => p.startsWith(`${name}=`));
  return decodeURIComponent(pair!.split('=')[1]!);
}

function setup(
  tokenStatus = 200,
  tokenBody: unknown = {
    access_token: fakeJwt('u1'),
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: 'r1',
    device_session_id: 'dsid-1',
  },
) {
  const net = recordingFetch(() => ({ status: tokenStatus, body: tokenBody }));
  const kv = memoryKv();
  const api = createNativeAuthApi({ baseUrl: 'https://sign.aramo.ai', fetch: net.fetch });
  const session = new SessionManager({ store: createTokenStore(kv), api });
  let opened = '';
  const deps = (open: SignInDeps['openAuthSession']): SignInDeps => ({
    env: ENV,
    platform: 'ios',
    osVersion: '18.0',
    api,
    session,
    describeDevice: async () => DEVICE,
    crypto: nodeCrypto,
    lateCallbackMs: 20,
    openAuthSession: async (url, redirect) => {
      opened = url;
      return open(url, redirect);
    },
  });
  return { net, kv, session, deps, opened: () => opened };
}

describe('Cognito sign-out URL', () => {
  it('ends the Cognito browser session and returns to the app sign-out address', () => {
    const url = new URL(
      buildLogoutUrl({ cognitoDomain: 'auth.example.com', clientId: 'client-1' }),
    );
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.example.com/logout');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('logout_uri')).toBe(NATIVE_SIGNOUT_REDIRECT_URI);
    expect(() => buildLogoutUrl({ cognitoDomain: 'evil.com/x?', clientId: 'c' })).toThrow();
  });
});

describe('native sign-in (M-A1 §3.2-§3.3)', () => {
  it('exchanges code + verifier + nonce + redirect + device, and stores tokens in SecureStore only', async () => {
    const t = setup();
    await t.session.restore();
    await signInWithProvider(
      'google',
      t.deps(async (url) => ({
        type: 'success',
        url: `${NATIVE_REDIRECT_URI}?code=the-code&state=${param(url, 'state')}`,
      })),
    );
    expect(t.net.calls).toHaveLength(1);
    const call = t.net.calls[0]!;
    expect(call.url).toBe('https://sign.aramo.ai/auth/native/sign/token');
    expect(call.headers['Authorization']).toBeUndefined();
    const body = call.body as {
      code: string;
      code_verifier: string;
      redirect_uri: string;
      nonce: string;
      device: unknown;
    };
    expect(body.code).toBe('the-code');
    expect(body.redirect_uri).toBe(NATIVE_REDIRECT_URI);
    expect(body.device).toEqual(DEVICE);
    // The verifier POSTed is the one whose S256 challenge went to Cognito; same nonce.
    await expect(codeChallengeS256(body.code_verifier, nodeCrypto)).resolves.toBe(
      param(t.opened(), 'code_challenge'),
    );
    expect(body.nonce).toBe(param(t.opened(), 'nonce'));
    // The provider's account picker always shows; a browser session is offered, never silent.
    expect(param(t.opened(), 'prompt')).toBe('select_account');
    expect(param(t.opened(), 'identity_provider')).toBe('Google');
    expect(t.session.snapshot()).toMatchObject({ status: 'signedIn', deviceSessionId: 'dsid-1' });
    expect(t.kv.items.get(SECURE_KEYS.refreshToken)).toBe('r1');
  });

  it('uses the custom-scheme fallback on iOS below 17.4', async () => {
    const t = setup();
    const d = {
      ...t.deps(async (url, redirect) => ({
        type: 'success',
        url: `${redirect}?code=c&state=${param(url, 'state')}`,
      })),
      osVersion: '16.4',
    };
    await signInWithProvider('google', d);
    expect(param(t.opened(), 'redirect_uri')).toBe(NATIVE_FALLBACK_REDIRECT_URI);
    expect((t.net.calls[0]!.body as { redirect_uri: string }).redirect_uri).toBe(
      NATIVE_FALLBACK_REDIRECT_URI,
    );
  });

  it('refuses a callback whose state does not match, without calling the server', async () => {
    const t = setup();
    await expect(
      signInWithProvider(
        'google',
        t.deps(async () => ({
          type: 'success',
          url: `${NATIVE_REDIRECT_URI}?code=c&state=forged`,
        })),
      ),
    ).rejects.toMatchObject({ reason: 'state_mismatch' });
    expect(t.net.calls).toHaveLength(0);
  });

  it('treats a closed browser as cancelled', async () => {
    const t = setup();
    await expect(
      signInWithProvider(
        'google',
        t.deps(async () => ({ type: 'cancel' })),
      ),
    ).rejects.toMatchObject({ reason: 'auth_cancelled' });
  });

  it('accepts a callback delivered as a deep link after the browser closed (Android)', async () => {
    const t = setup();
    const done = signInWithProvider(
      'google',
      t.deps(async (url) => {
        setTimeout(
          () => deliverCallback(`${NATIVE_REDIRECT_URI}?code=late&state=${param(url, 'state')}`),
          5,
        );
        return { type: 'dismiss' };
      }),
    );
    await expect(done).resolves.toEqual({ linkRefused: null });
    expect((t.net.calls[0]!.body as { code: string }).code).toBe('late');
  });

  it('maps the Personal Microsoft refusal to the provider-neutral copy (Apple Go-Live W4)', async () => {
    const t = setup(403, {
      error: {
        code: 'AUTH_FORBIDDEN',
        message: 'server text',
        request_id: 'r',
        details: { reason: 'idp_not_permitted_for_tenant' },
      },
    });
    const err: unknown = await signInWithProvider(
      'microsoft',
      t.deps(async (url) => ({
        type: 'success',
        url: `${NATIVE_REDIRECT_URI}?code=c&state=${param(url, 'state')}`,
      })),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).reason).toBe('idp_not_permitted_for_tenant');
    expect(refusalMessage(err as ApiError)).toBe(
      'Your account doesn’t use this sign-in option. Sign in the way you usually do.',
    );
    expect(t.kv.items.size).toBe(0);
  });

  it('refuses to start without a configured Cognito domain / native client id', async () => {
    const t = setup();
    await expect(
      signInWithProvider('google', {
        ...t.deps(async () => ({ type: 'cancel' })),
        env: { ...ENV, nativeClientId: null },
      }),
    ).rejects.toMatchObject({
      reason: 'auth_not_configured',
    });
  });
});

const ok = (url: string, redirect: string): Promise<AuthSessionResult> =>
  Promise.resolve({
    type: 'success',
    url: `${redirect}?code=the-code&state=${param(url, 'state')}`,
  });

describe('Sign in with Apple (Apple Go-Live R-1 / W4)', () => {
  it('uses the Cognito provider SignInWithApple and sends no prompt=select_account', async () => {
    const t = setup();
    await signInWithProvider('apple', t.deps(ok));
    const q = new URL(t.opened()).searchParams;
    expect(q.get('identity_provider')).toBe('SignInWithApple');
    expect(q.has('prompt')).toBe(false);
    expect(t.net.calls[0]!.url).toBe('https://sign.aramo.ai/auth/native/sign/token');
  });

  it('A1 L-4 proof (a): the pending-link handle rides on the token call; link_refused is returned', async () => {
    const t = setup(200, {
      access_token: fakeJwt('u1'),
      token_type: 'Bearer',
      expires_in: 900,
      refresh_token: 'r1',
      device_session_id: 'dsid-1',
      link_refused: 'idp_already_linked',
    });
    const out = await signInWithProvider('google', t.deps(ok), { linkHandle: 'h'.repeat(43) });
    expect((t.net.calls[0]!.body as { link_handle?: string }).link_handle).toBe('h'.repeat(43));
    expect(out).toEqual({ linkRefused: 'idp_already_linked' });
    expect(t.session.snapshot().status).toBe('signedIn');
  });

  it('without a handle the token body has no link_handle', async () => {
    const t = setup();
    await signInWithProvider('google', t.deps(ok));
    expect(t.net.calls[0]!.body).not.toHaveProperty('link_handle');
  });

  it('A1 path 1: linkProvider authorizes with the provider and posts the same body to link', async () => {
    const t = setup();
    const link = jest.fn(async () => ({ linked: true as const, idp: 'apple' as const }));
    const deps = t.deps(ok);
    await expect(
      linkProvider('apple', { ...deps, describeDevice: deps.describeDevice, link }),
    ).resolves.toEqual({ linked: true, idp: 'apple' });
    expect(link).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'the-code',
        redirect_uri: NATIVE_REDIRECT_URI,
        device: DEVICE,
      }),
    );
    // Linking never touches the token endpoint or the session.
    expect(t.net.calls).toHaveLength(0);
  });
});

describe('Apple-first signup identity (Apple Go-Live R-5, native)', () => {
  function idToken(claims: Record<string, unknown>): string {
    const enc = (o: unknown) => base64UrlEncode(utf8Encode(JSON.stringify(o)));
    return `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`;
  }

  it('redeems the code at Cognito (PKCE, no secret), reads email + name from the ID token and keeps no token', async () => {
    const t = setup();
    let nonce = '';
    const cognito = recordingFetch(() => {
      return {
        status: 200,
        body: {
          id_token: idToken({
            email: 'x1@privaterelay.appleid.com',
            given_name: 'Pat',
            family_name: 'Lee',
            nonce,
          }),
          access_token: 'a',
          refresh_token: 'r',
        },
      };
    });
    const deps = t.deps(async (url, redirect) => {
      nonce = param(url, 'nonce');
      return ok(url, redirect);
    });
    const fetchSpy = jest.fn((url: string, init: RequestInit) => {
      expect(url).toBe('https://auth.example.aramo.ai/oauth2/token');
      const form = new URLSearchParams(String(init.body));
      expect(form.get('grant_type')).toBe('authorization_code');
      expect(form.get('client_id')).toBe('nativeclient123');
      expect(form.get('code')).toBe('the-code');
      expect(form.get('code_verifier')).toBeTruthy();
      expect(form.has('client_secret')).toBe(false);
      return cognito.fetch(url, { ...init, body: undefined });
    });
    await expect(appleSignupIdentity({ ...deps, fetch: fetchSpy })).resolves.toEqual({
      email: 'x1@privaterelay.appleid.com',
      givenName: 'Pat',
      familyName: 'Lee',
    });
    expect(param(t.opened(), 'identity_provider')).toBe('SignInWithApple');
    expect(t.net.calls).toHaveLength(0);
    expect(t.kv.items.size).toBe(0);
  });

  it('refuses an ID token whose nonce does not match, and a name Apple did not share is null', async () => {
    const t = setup();
    // The Cognito token call is form-encoded; the recorder only parses JSON, so drop the body.
    const answer = (claims: Record<string, unknown>) => (url: string, init: RequestInit) =>
      recordingFetch(() => ({ status: 200, body: { id_token: idToken(claims) } })).fetch(url, {
        ...init,
        body: undefined,
      });
    await expect(
      appleSignupIdentity({ ...t.deps(ok), fetch: answer({ email: 'a@b.co', nonce: 'other' }) }),
    ).rejects.toMatchObject({ reason: 'state_mismatch' });
    let nonce = '';
    const deps = t.deps(async (url, redirect) => {
      nonce = param(url, 'nonce');
      return ok(url, redirect);
    });
    const lazy: typeof fetch = (u, i) => answer({ email: 'a@b.co', nonce })(String(u), i ?? {});
    await expect(appleSignupIdentity({ ...deps, fetch: lazy })).resolves.toEqual({
      email: 'a@b.co',
      givenName: null,
      familyName: null,
    });
  });
});
