import { beforeAll, describe, expect, it } from 'vitest';

import {
  MicrosoftOAuthStateError,
  buildMicrosoftAuthorizeUrl,
  buildMicrosoftTokenEndpoint,
  decryptMicrosoftOAuthState,
  encryptMicrosoftOAuthState,
  generateMicrosoftPkce,
  isMicrosoftOAuthStateExpired,
  type MicrosoftOAuthStatePayload,
} from '../lib/domain/oauth-state.js';

// COMM-C2B R2 — delegated OAuth state/PKCE. The encrypted state is the only
// client-held value; it must round-trip, reject tampering (GCM), expire, and the
// authorize URL must carry S256 PKCE + only least-privilege scopes.

const KEY = Buffer.alloc(32, 7).toString('base64url');

const PAYLOAD: MicrosoftOAuthStatePayload = {
  tenant_id: '11111111-1111-7111-8111-111111111111',
  recruiter_id: '22222222-2222-7222-8222-222222222222',
  connection_id: '33333333-3333-7333-8333-333333333333',
  verifier: 'verifier-abc',
  nonce: 'nonce-xyz',
  issued_at: 1_000_000,
};

describe('COMM-C2B Microsoft OAuth state/PKCE (R2)', () => {
  beforeAll(() => {
    process.env['MSGRAPH_OAUTH_STATE_KEY'] = KEY;
  });

  it('generates an S256 PKCE pair (verifier + base64url challenge + nonce)', () => {
    const p = generateMicrosoftPkce();
    expect(p.verifier.length).toBeGreaterThanOrEqual(43);
    expect(p.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(p.nonce.length).toBeGreaterThan(0);
    expect(p.challenge).not.toBe(p.verifier);
  });

  it('round-trips the encrypted state', () => {
    const enc = encryptMicrosoftOAuthState(PAYLOAD);
    expect(enc).not.toContain(PAYLOAD.verifier); // verifier never appears in clear
    expect(decryptMicrosoftOAuthState(enc)).toEqual(PAYLOAD);
  });

  it('rejects a tampered state (GCM integrity)', () => {
    const enc = encryptMicrosoftOAuthState(PAYLOAD);
    const tampered = `${enc.slice(0, -2)}${enc.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    expect(() => decryptMicrosoftOAuthState(tampered)).toThrow(MicrosoftOAuthStateError);
  });

  it('flags an expired state past its TTL', () => {
    expect(isMicrosoftOAuthStateExpired(PAYLOAD, PAYLOAD.issued_at + 599)).toBe(false);
    expect(isMicrosoftOAuthStateExpired(PAYLOAD, PAYLOAD.issued_at + 601)).toBe(true);
  });

  it('throws when the state key is misconfigured', () => {
    const prev = process.env['MSGRAPH_OAUTH_STATE_KEY'];
    process.env['MSGRAPH_OAUTH_STATE_KEY'] = '';
    expect(() => encryptMicrosoftOAuthState(PAYLOAD)).toThrow(MicrosoftOAuthStateError);
    process.env['MSGRAPH_OAUTH_STATE_KEY'] = prev;
  });

  it('builds an authorize URL with S256 PKCE and only least-privilege scopes', () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl({
        clientId: 'client-123',
        redirectUri: 'https://app.example.com/v1/integrations/microsoft/callback',
        encryptedState: 'ENC',
        codeChallenge: 'CHAL',
      }),
    );
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe('/organizations/oauth2/v2.0/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('state')).toBe('ENC');
    expect(url.searchParams.get('scope')).toBe(
      'openid profile offline_access User.Read Mail.Send OnlineMeetings.ReadWrite',
    );
  });

  it('fails closed if a broader scope is smuggled into the authorize URL (R8)', () => {
    expect(() =>
      buildMicrosoftAuthorizeUrl({
        clientId: 'c',
        redirectUri: 'https://x/cb',
        encryptedState: 's',
        codeChallenge: 'ch',
        scopes: ['openid', 'Mail.ReadWrite'],
      }),
    ).toThrow();
  });

  it('derives the token endpoint for the configured authority tenant', () => {
    expect(buildMicrosoftTokenEndpoint('a-tenant-id')).toBe(
      'https://login.microsoftonline.com/a-tenant-id/oauth2/v2.0/token',
    );
  });
});
