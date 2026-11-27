import { createHash } from 'node:crypto';

import { CloudProviderError, OAUTH_SPECS, authorizeUrl, exchangeCode, pkceChallenge, randomToken, refreshAccessToken, revokeGrant, sha256Hex } from '../index.js';

import { fakeFetch, jsonRes } from './fake-fetch.js';

const CREDS = { client_id: 'cid', client_secret: 'secret' };
const NOW = new Date('2026-11-27T12:00:00.000Z');

describe('authorizeUrl', () => {
  it('Google: code flow, PKCE S256, offline access, read-only import + app-file export scopes', () => {
    const u = new URL(authorizeUrl('google_drive', CREDS, { redirect_uri: 'https://sign.example/cb', state: 'st', code_verifier: 'v'.repeat(43) }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBe(pkceChallenge('v'.repeat(43)));
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('scope')?.split(' ')).toEqual(['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file']);
  });

  it('OneDrive uses the common authority (personal and work accounts)', () => {
    const u = new URL(authorizeUrl('onedrive', CREDS, { redirect_uri: 'https://x/cb', state: 's', code_verifier: 'v' }));
    expect(u.pathname).toBe('/common/oauth2/v2.0/authorize');
    expect(u.searchParams.get('scope')).toBe('Files.ReadWrite User.Read offline_access');
  });

  it('Box sends no PKCE challenge (not supported); Dropbox asks for an offline token', () => {
    expect(new URL(authorizeUrl('box', CREDS, { redirect_uri: 'https://x/cb', state: 's', code_verifier: 'v' })).searchParams.has('code_challenge')).toBe(false);
    expect(new URL(authorizeUrl('dropbox', CREDS, { redirect_uri: 'https://x/cb', state: 's', code_verifier: 'v' })).searchParams.get('token_access_type')).toBe('offline');
  });

  it('only Google Drive refuses a chosen export folder (drive.file)', () => {
    expect(OAUTH_SPECS.google_drive.export_folder_choice).toBe(false);
    expect(OAUTH_SPECS.onedrive.export_folder_choice && OAUTH_SPECS.dropbox.export_folder_choice && OAUTH_SPECS.box.export_folder_choice).toBe(true);
  });
});

describe('PKCE and state helpers', () => {
  it('challenge = base64url(sha256(verifier))', () => {
    expect(pkceChallenge('abc')).toBe(createHash('sha256').update('abc').digest('base64url'));
  });
  it('random tokens are 43 base64url characters and differ', () => {
    const a = randomToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(a);
    expect(sha256Hex('x')).toHaveLength(64);
  });
});

describe('token requests', () => {
  it('exchanges the code with the verifier and the client secret (form body)', async () => {
    const f = fakeFetch([jsonRes({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'x' })]);
    const t = await exchangeCode('google_drive', CREDS, { code: 'c0de', redirect_uri: 'https://x/cb', code_verifier: 'ver' }, f, NOW);
    expect(t).toEqual({ access_token: 'at', refresh_token: 'rt', expires_at: new Date('2026-11-27T13:00:00.000Z'), scope: 'x' });
    const body = new URLSearchParams(String(f.calls[0]?.body));
    expect(f.calls[0]?.url).toBe('https://oauth2.googleapis.com/token');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('ver');
    expect(body.get('client_secret')).toBe('secret');
  });

  it('Box: no code_verifier on the exchange; Microsoft: scopes repeated', async () => {
    const box = fakeFetch([jsonRes({ access_token: 'a', refresh_token: 'r', expires_in: 60 })]);
    await exchangeCode('box', CREDS, { code: 'c', redirect_uri: 'https://x/cb', code_verifier: 'ver' }, box, NOW);
    expect(new URLSearchParams(String(box.calls[0]?.body)).has('code_verifier')).toBe(false);
    const ms = fakeFetch([jsonRes({ access_token: 'a', expires_in: 60 })]);
    await refreshAccessToken('onedrive', CREDS, 'rt', ms, NOW);
    const b = new URLSearchParams(String(ms.calls[0]?.body));
    expect(b.get('grant_type')).toBe('refresh_token');
    expect(b.get('scope')).toBe('Files.ReadWrite User.Read offline_access');
  });

  it('a refused grant (400 invalid_grant) is unauthorized: connect again', async () => {
    const f = fakeFetch([jsonRes({ error: 'invalid_grant' }, 400)]);
    await expect(refreshAccessToken('dropbox', CREDS, 'rt', f, NOW)).rejects.toMatchObject({ kind: 'unauthorized' });
  });

  it('a response without an access token fails', async () => {
    const f = fakeFetch([jsonRes({ token_type: 'bearer' })]);
    await expect(exchangeCode('dropbox', CREDS, { code: 'c', redirect_uri: 'https://x', code_verifier: 'v' }, f, NOW)).rejects.toBeInstanceOf(CloudProviderError);
  });

  it('keeps a missing refresh token as null (the stored one stays)', async () => {
    const f = fakeFetch([jsonRes({ access_token: 'a' })]);
    expect((await refreshAccessToken('google_drive', CREDS, 'rt', f, NOW)).refresh_token).toBeNull();
  });
});

describe('revokeGrant', () => {
  it('Google revokes the refresh token; Dropbox revokes with the access token; Box sends the client', async () => {
    const g = fakeFetch([new Response(null, { status: 200 })]);
    expect(await revokeGrant('google_drive', CREDS, { access_token: 'a', refresh_token: 'r' }, g)).toBe(true);
    expect(new URLSearchParams(String(g.calls[0]?.body)).get('token')).toBe('r');
    const d = fakeFetch([new Response(null, { status: 200 })]);
    await revokeGrant('dropbox', CREDS, { access_token: 'a', refresh_token: 'r' }, d);
    expect(d.calls[0]?.headers['authorization']).toBe('Bearer a');
    const b = fakeFetch([new Response(null, { status: 200 })]);
    await revokeGrant('box', CREDS, { access_token: 'a', refresh_token: null }, b);
    expect(new URLSearchParams(String(b.calls[0]?.body)).get('client_id')).toBe('cid');
  });

  it('Microsoft has no revoke endpoint; a failed call is false, never thrown', async () => {
    const none = fakeFetch([]);
    expect(await revokeGrant('onedrive', CREDS, { access_token: 'a', refresh_token: 'r' }, none)).toBe(false);
    expect(none.calls).toHaveLength(0);
    const bad = fakeFetch([new Response(null, { status: 500 })]);
    expect(await revokeGrant('google_drive', CREDS, { access_token: 'a', refresh_token: null }, bad)).toBe(false);
  });
});
