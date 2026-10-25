import { NATIVE_FALLBACK_REDIRECT_URI, NATIVE_REDIRECT_URI } from '../../config/env';
import { nodeCrypto } from '../../testing/fakes';
import { buildAuthorizeUrl, parseAuthCallback, selectRedirectUri } from '../authorize';
import { codeChallengeS256, createAuthRequestSecrets, platformCrypto, safeEqual } from '../pkce';

const B64URL = /^[A-Za-z0-9_-]+$/;

describe('PKCE S256 (RFC 7636)', () => {
  it('matches the RFC 7636 Appendix B test vector', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await expect(codeChallengeS256(verifier, nodeCrypto)).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('the platform adapter (expo-crypto digest) yields the same challenge', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    await expect(codeChallengeS256(verifier, platformCrypto)).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates a 43-char base64url verifier and independent state/nonce per attempt', async () => {
    const a = await createAuthRequestSecrets(nodeCrypto);
    const b = await createAuthRequestSecrets(nodeCrypto);
    expect(a.codeVerifier).toHaveLength(43);
    for (const v of [a.codeVerifier, a.codeChallenge, a.state, a.nonce]) expect(v).toMatch(B64URL);
    expect(a.state).not.toBe(a.nonce);
    expect(new Set([a.codeVerifier, b.codeVerifier, a.state, b.state, a.nonce, b.nonce]).size).toBe(
      6,
    );
    await expect(codeChallengeS256(a.codeVerifier, nodeCrypto)).resolves.toBe(a.codeChallenge);
  });

  it('rejects a verifier outside the RFC charset/length', async () => {
    await expect(codeChallengeS256('short', nodeCrypto)).rejects.toThrow('invalid PKCE verifier');
  });

  it('safeEqual compares exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('authorize request', () => {
  const base = {
    cognitoDomain: 'auth.example.aramo.ai',
    clientId: 'nativeclient123',
    state: 'st',
    nonce: 'nn',
    codeChallenge: 'ch',
  };

  it('builds the Cognito authorize URL with PKCE S256, state, nonce and the provider hint', () => {
    const url = buildAuthorizeUrl({
      ...base,
      redirectUri: NATIVE_REDIRECT_URI,
      provider: 'google',
    });
    expect(url.startsWith('https://auth.example.aramo.ai/oauth2/authorize?')).toBe(true);
    const q = new Map(
      url
        .split('?')[1]!
        .split('&')
        .map((p) => p.split('=').map(decodeURIComponent) as [string, string]),
    );
    expect(Object.fromEntries(q)).toEqual({
      client_id: 'nativeclient123',
      response_type: 'code',
      redirect_uri: NATIVE_REDIRECT_URI,
      scope: 'openid email profile',
      state: 'st',
      nonce: 'nn',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      identity_provider: 'Google',
    });
    expect(url).not.toContain('client_secret');
    expect(
      buildAuthorizeUrl({ ...base, redirectUri: NATIVE_REDIRECT_URI, provider: 'microsoft' }),
    ).toContain('identity_provider=microsoft');
  });

  it('refuses an unregistered redirect URI or a malformed domain', () => {
    expect(() =>
      buildAuthorizeUrl({ ...base, redirectUri: 'https://evil.example/cb', provider: 'google' }),
    ).toThrow();
    expect(() =>
      buildAuthorizeUrl({
        ...base,
        cognitoDomain: 'evil.example/x?',
        redirectUri: NATIVE_REDIRECT_URI,
        provider: 'google',
      }),
    ).toThrow();
  });

  it('selects the https callback where the OS can receive it, else the custom-scheme fallback', () => {
    expect(selectRedirectUri('ios', '17.4', 'https')).toBe(NATIVE_REDIRECT_URI);
    expect(selectRedirectUri('ios', '18.1', 'https')).toBe(NATIVE_REDIRECT_URI);
    expect(selectRedirectUri('ios', '17.3', 'https')).toBe(NATIVE_FALLBACK_REDIRECT_URI);
    expect(selectRedirectUri('ios', '16.4', 'https')).toBe(NATIVE_FALLBACK_REDIRECT_URI);
    expect(selectRedirectUri('android', 34, 'https')).toBe(NATIVE_REDIRECT_URI);
    expect(selectRedirectUri('android', 34, 'custom')).toBe(NATIVE_FALLBACK_REDIRECT_URI);
  });
});

describe('callback validation', () => {
  it('accepts the exact callback with the matching state', () => {
    expect(
      parseAuthCallback(`${NATIVE_REDIRECT_URI}?code=abc-123&state=s1`, NATIVE_REDIRECT_URI, 's1'),
    ).toEqual({ ok: true, code: 'abc-123' });
  });
  it('refuses a state mismatch or a missing state', () => {
    expect(
      parseAuthCallback(`${NATIVE_REDIRECT_URI}?code=abc&state=other`, NATIVE_REDIRECT_URI, 's1'),
    ).toEqual({ ok: false, reason: 'state_mismatch' });
    expect(parseAuthCallback(`${NATIVE_REDIRECT_URI}?code=abc`, NATIVE_REDIRECT_URI, 's1')).toEqual(
      { ok: false, reason: 'state_mismatch' },
    );
  });
  it('refuses a callback on another URL', () => {
    expect(
      parseAuthCallback(
        `https://sign.aramo.ai/auth/native/callbackX?code=a&state=s1`,
        NATIVE_REDIRECT_URI,
        's1',
      ).ok,
    ).toBe(false);
    expect(
      parseAuthCallback(
        `${NATIVE_FALLBACK_REDIRECT_URI}?code=a&state=s1`,
        NATIVE_REDIRECT_URI,
        's1',
      ).ok,
    ).toBe(false);
  });
  it('reports an IdP error as authorization_denied (after the state check)', () => {
    expect(
      parseAuthCallback(
        `${NATIVE_REDIRECT_URI}?error=access_denied&state=s1`,
        NATIVE_REDIRECT_URI,
        's1',
      ),
    ).toEqual({ ok: false, reason: 'authorization_denied' });
  });
});
