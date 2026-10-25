import { ApiError } from '../../api/errors';
import { refusalMessage } from '../../api/refusalMessages';
import { NATIVE_FALLBACK_REDIRECT_URI, NATIVE_REDIRECT_URI } from '../../config/env';
import { fakeJwt, memoryKv, nodeCrypto, recordingFetch } from '../../testing/fakes';
import { deliverCallback } from '../callbackBus';
import { createNativeAuthApi } from '../nativeAuthApi';
import { codeChallengeS256 } from '../pkce';
import { SessionManager } from '../session';
import { signInWithProvider, type SignInDeps } from '../signIn';
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
    await expect(done).resolves.toBeUndefined();
    expect((t.net.calls[0]!.body as { code: string }).code).toBe('late');
  });

  it('maps the Personal Microsoft refusal to "Personal accounts sign in with Google."', async () => {
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
    expect(refusalMessage(err as ApiError)).toBe('Personal accounts sign in with Google.');
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
