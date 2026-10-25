import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CognitoNativeCodeExchangeAdapter } from '../lib/native-code-exchange.port.js';

// AUTH-SIGNIN-1 Amendment M-A1 §3.3 — the production Cognito adapter behind
// NATIVE_CODE_EXCHANGE. fetch is stubbed: no network, no real Cognito.
describe('CognitoNativeCodeExchangeAdapter', () => {
  const input = {
    code: 'code-1',
    code_verifier: 'v'.repeat(43),
    redirect_uri: 'aramosign://auth/callback',
    client_id: 'native-client',
  };
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env['AUTH_COGNITO_DOMAIN'];
    process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (saved === undefined) delete process.env['AUTH_COGNITO_DOMAIN'];
    else process.env['AUTH_COGNITO_DOMAIN'] = saved;
  });

  it('posts a PUBLIC-client authorization_code grant (native client id, the app verifier + redirect, no secret)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id_token: 'id.tok' }) });
    vi.stubGlobal('fetch', fetchMock);
    const out = await new CognitoNativeCodeExchangeAdapter().exchange(input);
    expect(out).toEqual({ kind: 'ok', id_token: 'id.tok' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://auth.example.com/oauth2/token');
    const body = new URLSearchParams((init as { body: string }).body);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'native-client',
      code: 'code-1',
      redirect_uri: 'aramosign://auth/callback',
      code_verifier: 'v'.repeat(43),
    });
    expect((init as { headers: Record<string, string> }).headers['Authorization']).toBeUndefined();
  });

  it('maps a 4xx (PKCE mismatch / used code) to rejected with the OAuth error code only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => '{"error":"invalid_grant","error_description":"x"}' }));
    expect(await new CognitoNativeCodeExchangeAdapter().exchange(input)).toEqual({ kind: 'rejected', oauth_error: 'invalid_grant' });
  });

  it('maps a 5xx, a network failure and a missing id_token to unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));
    expect((await new CognitoNativeCodeExchangeAdapter().exchange(input)).kind).toBe('unavailable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));
    expect((await new CognitoNativeCodeExchangeAdapter().exchange(input)).kind).toBe('unavailable');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }));
    expect((await new CognitoNativeCodeExchangeAdapter().exchange(input)).kind).toBe('unavailable');
  });
});
