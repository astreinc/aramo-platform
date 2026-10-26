// M-A2 §2.1 / §5 "Credential isolation": every guest-transport request lacks
// Authorization; every workspace request lacks a signing token; no request carries both.
import { createGuestSigningClient } from '../guestSigningClient';
import { createWorkspaceClient, type WorkspaceSessionPort } from '../workspaceClient';
import { SIGNING_TOKEN, recordingFetch, type RecordedRequest } from '../../testing/fakes';

const BASE = 'https://sign.aramo.ai';
const ACCESS = 'access.jwt.value';

function session(): WorkspaceSessionPort {
  return {
    getAccessToken: async () => ACCESS,
    refreshAccessToken: async () => ACCESS,
    sessionExpired: jest.fn(),
  };
}

function hasHeader(r: RecordedRequest, name: string): boolean {
  return Object.keys(r.headers).some((k) => k.toLowerCase() === name.toLowerCase());
}

describe('two isolated transports', () => {
  it('workspace requests carry Bearer + X-Aramo-Consumer and no signing token', async () => {
    const net = recordingFetch(() => ({ status: 200, body: { items: [] } }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: net.fetch, session: session() });
    await ws.call('/v1/sign/sender/envelopes/{id}', 'get', { path: { id: 'e1' } });
    await ws.request({
      method: 'POST',
      path: '/v1/sign/sender/envelopes/e1/remind',
      body: { signer_id: 's1' },
      idempotencyKey: 'key-12345678',
    });
    for (const r of net.calls) {
      expect(r.headers['Authorization']).toBe(`Bearer ${ACCESS}`);
      expect(r.headers['X-Aramo-Consumer']).toBe('sign');
      expect(r.url.startsWith(`${BASE}/v1/sign/signing/`)).toBe(false);
      expect(JSON.stringify(r.body ?? {})).not.toContain(SIGNING_TOKEN);
    }
    expect(net.calls[1]!.headers['Idempotency-Key']).toBe('key-12345678');
  });

  it('guest requests carry ONLY the signing token: no Authorization, no consumer header', async () => {
    const net = recordingFetch(() => ({ status: 200, body: { session_id: 'x' } }));
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
    await guest.post('/v1/sign/signing/exchange');
    await guest.post('/v1/sign/signing/document');
    await guest.postRaw('/v1/sign/signing/fields/f1/fill', { value: 'Jo' });
    expect(net.calls).toHaveLength(3);
    for (const r of net.calls) {
      expect(hasHeader(r, 'Authorization')).toBe(false);
      expect(hasHeader(r, 'X-Aramo-Consumer')).toBe(false);
      expect(hasHeader(r, 'Cookie')).toBe(false);
      expect(r.body?.['token']).toBe(SIGNING_TOKEN);
      expect(r.url.startsWith(`${BASE}/v1/sign/signing/`)).toBe(true);
    }
  });

  it('interleaved use of both clients never mixes credentials on one request', async () => {
    const net = recordingFetch(() => ({ status: 200, body: {} }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: net.fetch, session: session() });
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
    await Promise.all([
      ws.request({ method: 'GET', path: '/v1/sign/inbox' }),
      guest.post('/v1/sign/signing/document'),
      ws.request({ method: 'GET', path: '/v1/sign/sender/summary' }),
      guest.post('/v1/sign/signing/disclosure-text'),
    ]);
    expect(net.calls).toHaveLength(4);
    for (const r of net.calls) {
      const bearer = hasHeader(r, 'Authorization');
      const token = r.body?.['token'] !== undefined;
      expect(bearer && token).toBe(false);
      expect(bearer || token).toBe(true);
    }
  });

  it('each transport refuses the other one’s paths before any network call', async () => {
    const net = recordingFetch(() => ({ status: 200, body: {} }));
    const ws = createWorkspaceClient({ baseUrl: BASE, fetch: net.fetch, session: session() });
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
    await expect(
      ws.request({
        method: 'POST',
        path: '/v1/sign/signing/exchange',
        body: { token: SIGNING_TOKEN },
      }),
    ).rejects.toThrow('guest signing paths are not reachable on the workspace transport');
    await expect(guest.postRaw('/v1/sign/signing/../sender/summary')).rejects.toThrow(
      'dot or empty segments',
    );
    await expect(
      ws.request({ method: 'POST', path: '/v1/sign/sender/../signing/exchange' }),
    ).rejects.toThrow('dot or empty segments');
    await expect(
      ws.request({ method: 'POST', path: '/v1/sign/sender/%2e%2e/signing/exchange' }),
    ).rejects.toThrow('dot or empty segments');
    await expect(
      ws.call('/v1/sign/sender/envelopes/{id}', 'get', { path: { id: '..' } }),
    ).rejects.toThrow('dot or empty segments');
    await expect(
      (guest as unknown as { postRaw: (p: string) => Promise<unknown> }).postRaw(
        '/v1/sign/sender/summary',
      ),
    ).rejects.toThrow('only signing paths are reachable on the guest transport');
    expect(
      net.calls.filter(
        (c) => c.url.includes('/sender/summary') || c.url.endsWith('/signing/exchange'),
      ),
    ).toHaveLength(0);
  });
});

describe('guest token lifecycle (M-A2 §2.3, C-21)', () => {
  it.each(['SIGNING_SESSION_EXPIRED', 'SIGNING_SESSION_INVALID'])(
    'discards the token on %s and never retries',
    async (code) => {
      const net = recordingFetch(() => ({
        status: 401,
        body: { error: { code, message: 'x', request_id: 'r', details: {} } },
      }));
      const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(
        SIGNING_TOKEN,
      );
      await expect(guest.post('/v1/sign/signing/document')).rejects.toMatchObject({ reason: code });
      expect(guest.active).toBe(false);
      await expect(guest.post('/v1/sign/signing/document')).rejects.toMatchObject({
        reason: 'signing_session_ended',
      });
      expect(net.calls).toHaveLength(1);
    },
  );

  it('discards on a session_revoked reason (reminder revoked the session)', async () => {
    const net = recordingFetch(() => ({
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'x',
          request_id: 'r',
          details: { reason: 'session_revoked' },
        },
      },
    }));
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
    await expect(guest.postRaw('/v1/sign/signing/complete')).rejects.toMatchObject({
      reason: 'session_revoked',
    });
    expect(guest.active).toBe(false);
  });

  it('keeps the token on an ordinary refusal (e.g. a required field missing)', async () => {
    const net = recordingFetch(() => ({
      status: 409,
      body: {
        error: { code: 'SIGNATURE_FIELD_INCOMPLETE', message: 'x', request_id: 'r', details: {} },
      },
    }));
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
    await expect(guest.postRaw('/v1/sign/signing/complete')).rejects.toMatchObject({
      reason: 'SIGNATURE_FIELD_INCOMPLETE',
    });
    expect(guest.active).toBe(true);
  });

  it('discard() forgets the token immediately', async () => {
    const net = recordingFetch(() => ({ status: 200, body: {} }));
    const guest = createGuestSigningClient({ baseUrl: BASE, fetch: net.fetch }).open(SIGNING_TOKEN);
    guest.discard();
    await expect(guest.post('/v1/sign/signing/document')).rejects.toMatchObject({
      reason: 'signing_session_ended',
    });
    expect(net.calls).toHaveLength(0);
  });
});
