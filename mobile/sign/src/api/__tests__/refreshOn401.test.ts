import { ApiError } from '../errors';
import { createWorkspaceClient } from '../workspaceClient';
import { createNativeAuthApi } from '../../auth/nativeAuthApi';
import { SessionManager } from '../../auth/session';
import { SECURE_KEYS } from '../../auth/secureKeyValue';
import { createTokenStore } from '../../auth/tokenStore';
import { memoryKv, recordingFetch } from '../../testing/fakes';

const BASE = 'https://sign.aramo.ai';
const NOW = 1_800_000_000_000;

function tokenResponse(n: number) {
  return {
    access_token: `access-${n}`,
    token_type: 'Bearer',
    expires_in: 900,
    refresh_token: `refresh-${n}`,
    device_session_id: 'dsid-1',
  };
}

async function signedIn(
  authResponder: Parameters<typeof recordingFetch>[0],
  opts: { accessExpiresAt?: number } = {},
) {
  const kv = memoryKv();
  const store = createTokenStore(kv);
  await store.save({
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    accessExpiresAt: opts.accessExpiresAt ?? NOW + 600_000,
    deviceSessionId: 'dsid-1',
  });
  const auth = recordingFetch(authResponder);
  const session = new SessionManager({
    store,
    api: createNativeAuthApi({ baseUrl: BASE, fetch: auth.fetch }),
    now: () => NOW,
  });
  await session.restore();
  return { kv, store, auth, session };
}

describe('workspace refresh-on-401', () => {
  it('rotates once and retries the request with the new access token', async () => {
    let n = 0;
    const t = await signedIn(() => ({ status: 200, body: tokenResponse(++n) }));
    const api = recordingFetch((r) =>
      r.headers['Authorization'] === 'Bearer access-0'
        ? {
            status: 401,
            body: { error: { code: 'UNAUTHORIZED', message: '', request_id: 'r', details: {} } },
          }
        : { status: 200, body: { ok: true } },
    );
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: api.fetch, session: t.session });
    await expect(ws.request({ method: 'GET', path: '/v1/sign/inbox' })).resolves.toMatchObject({
      status: 200,
      data: { ok: true },
    });
    expect(api.calls.map((c) => c.headers['Authorization'])).toEqual([
      'Bearer access-0',
      'Bearer access-1',
    ]);
    expect(t.auth.calls).toHaveLength(1);
    expect(t.auth.calls[0]!.body).toEqual({ refresh_token: 'refresh-0' });
    expect(t.kv.items.get(SECURE_KEYS.refreshToken)).toBe('refresh-1');
  });

  it('shares ONE refresh across concurrent 401s (no refresh-token reuse)', async () => {
    let n = 0;
    const t = await signedIn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { status: 200, body: tokenResponse(++n) };
    });
    const api = recordingFetch((r) =>
      r.headers['Authorization'] === 'Bearer access-0'
        ? { status: 401, body: {} }
        : { status: 200, body: {} },
    );
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: api.fetch, session: t.session });
    await Promise.all(
      [1, 2, 3, 4].map(() => ws.request({ method: 'GET', path: '/v1/sign/inbox' })),
    );
    expect(t.auth.calls).toHaveLength(1);
    expect(api.calls.filter((c) => c.headers['Authorization'] === 'Bearer access-1')).toHaveLength(
      4,
    );
  });

  it('refreshes ahead of expiry without a 401 round trip', async () => {
    const t = await signedIn(() => ({ status: 200, body: tokenResponse(1) }), {
      accessExpiresAt: NOW + 10_000,
    });
    const api = recordingFetch(() => ({ status: 200, body: {} }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: api.fetch, session: t.session });
    await ws.request({ method: 'GET', path: '/v1/sign/inbox' });
    expect(api.calls.map((c) => c.headers['Authorization'])).toEqual(['Bearer access-1']);
  });

  it('a refused refresh (reuse detected / invalid) ends the session and clears SecureStore', async () => {
    const t = await signedIn(() => ({
      status: 401,
      body: {
        error: {
          code: 'UNAUTHORIZED',
          message: '',
          request_id: 'r',
          details: { reason: 'session_reuse_detected' },
        },
      },
    }));
    const api = recordingFetch(() => ({ status: 401, body: {} }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: api.fetch, session: t.session });
    const err = await ws
      .request({ method: 'GET', path: '/v1/sign/inbox' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).reason).toBe('session_expired');
    expect(t.session.snapshot()).toMatchObject({ status: 'signedOut', cause: 'expired' });
    expect(t.kv.items.size).toBe(0);
    expect(api.calls).toHaveLength(1);
  });

  it('a second 401 after a successful refresh also ends the session', async () => {
    const t = await signedIn(() => ({ status: 200, body: tokenResponse(1) }));
    const api = recordingFetch(() => ({ status: 401, body: {} }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: api.fetch, session: t.session });
    await expect(ws.request({ method: 'GET', path: '/v1/sign/inbox' })).rejects.toMatchObject({
      reason: 'session_expired',
    });
    expect(api.calls).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 0));
    expect(t.session.snapshot().status).toBe('signedOut');
  });

  it('a network failure during refresh keeps the session (offline is not sign-out)', async () => {
    const t = await signedIn(
      () => {
        throw new TypeError('Network request failed');
      },
      { accessExpiresAt: NOW },
    );
    const api = recordingFetch(() => ({ status: 200, body: {} }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: api.fetch, session: t.session });
    await expect(ws.request({ method: 'GET', path: '/v1/sign/inbox' })).rejects.toMatchObject({
      reason: 'network_unavailable',
    });
    expect(t.session.snapshot().status).toBe('signedIn');
    expect(t.kv.items.get(SECURE_KEYS.refreshToken)).toBe('refresh-0');
  });

  it('non-401 refusals pass through untouched (no refresh)', async () => {
    const t = await signedIn(() => ({ status: 200, body: tokenResponse(1) }));
    const api = recordingFetch(() => ({
      status: 412,
      body: {
        error: {
          code: 'PRECONDITION_FAILED',
          message: '',
          request_id: 'r',
          details: { reason: 'revision_mismatch', current_revision: 7 },
        },
      },
    }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: api.fetch, session: t.session });
    const err = (await ws
      .request({
        method: 'PATCH',
        path: '/v1/sign/sender/envelopes/e1',
        body: {},
        ifMatch: { id: 'e1', revision: 6 },
      })
      .catch((e: unknown) => e)) as ApiError;
    expect(err.reason).toBe('revision_mismatch');
    expect(err.currentRevision).toBe(7);
    expect(api.calls[0]!.headers['If-Match']).toBe('"e1.6"');
    expect(t.auth.calls).toHaveLength(0);
  });

  it('sign-out revokes on the server and wipes SecureStore', async () => {
    const t = await signedIn(() => ({ status: 204 }));
    await t.session.signOut();
    expect(t.auth.calls.map((c) => [c.url, c.body])).toEqual([
      [`${BASE}/auth/native/sign/logout`, { refresh_token: 'refresh-0' }],
    ]);
    expect(t.kv.items.size).toBe(0);
    expect(t.session.snapshot()).toMatchObject({ status: 'signedOut', cause: 'signedOut' });
  });
});
