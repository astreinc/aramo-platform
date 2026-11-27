import { createHash, randomBytes } from 'node:crypto';

import { call, json } from './http.js';
import { CloudProviderError, type CloudProviderId, type FetchLike } from './types.js';

// SIGN-FREE-PARITY-1 S6 — the OAuth 2.0 authorization-code flow, run entirely by sign-service
// (a confidential client with a client secret; PKCE S256 wherever the provider supports it).
// The browser only follows redirects: provider → sign-service callback → the Sign web app (or
// the Aramo Sign app). No provider script, frame or API call runs in the page, so the Sign web
// Content-Security-Policy is unchanged.
//
// Scope choices (least privilege that does the job; FP-R7):
//   Google Drive  drive.readonly + drive.file. Choosing an EXISTING file without Google's
//                 Picker (a third-party script the CSP blocks) needs drive.readonly; saving
//                 needs only drive.file (files and folders this app creates). drive.file can't
//                 write into a folder the user made, so on Google Drive the signed copy always
//                 goes to the "Aramo Sign" folder (export_folder_choice false). drive.readonly
//                 is a Google "restricted" scope: the OAuth app needs Google's verification
//                 (and its security assessment) before it can go live.
//   OneDrive      Files.ReadWrite + User.Read + offline_access, authority `common` (personal
//                 Microsoft accounts AND work or school accounts). Files.Read cannot save;
//                 Files.ReadWrite.AppFolder can save only under Apps/<app name> (not to a
//                 folder the user picks) and its support on work accounts is limited, so
//                 Files.ReadWrite is the least scope that imports and saves to a chosen folder.
//                 User.Read only labels the account (email). Microsoft has no token revoke
//                 endpoint: disconnecting deletes the tokens; the user can also remove the app
//                 from their account's app permissions.
//   Dropbox       files.metadata.read, files.content.read, files.content.write,
//                 account_info.read (the account email). token_access_type=offline.
//   Box           root_readwrite (Box has no read-only file scope). Box does not support
//                 PKCE: state + the client secret protect the exchange.

export interface OAuthProviderSpec {
  readonly authorize_url: string;
  readonly token_url: string;
  /** Null when the provider has no revoke endpoint (Microsoft). */
  readonly revoke_url: string | null;
  readonly scopes: readonly string[];
  readonly pkce: boolean;
  /** Microsoft wants the scopes again on the token request. */
  readonly scope_on_token: boolean;
  readonly authorize_params: Readonly<Record<string, string>>;
  /** Saving to a folder the user chooses works (false on Google Drive: drive.file). */
  readonly export_folder_choice: boolean;
}

export const OAUTH_SPECS: Readonly<Record<CloudProviderId, OAuthProviderSpec>> = {
  google_drive: {
    authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
    token_url: 'https://oauth2.googleapis.com/token',
    revoke_url: 'https://oauth2.googleapis.com/revoke',
    scopes: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
    pkce: true,
    scope_on_token: false,
    authorize_params: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
    export_folder_choice: false,
  },
  onedrive: {
    authorize_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token_url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    revoke_url: null,
    scopes: ['Files.ReadWrite', 'User.Read', 'offline_access'],
    pkce: true,
    scope_on_token: true,
    authorize_params: { response_mode: 'query', prompt: 'select_account' },
    export_folder_choice: true,
  },
  dropbox: {
    authorize_url: 'https://www.dropbox.com/oauth2/authorize',
    token_url: 'https://api.dropboxapi.com/oauth2/token',
    revoke_url: 'https://api.dropboxapi.com/2/auth/token/revoke',
    scopes: ['account_info.read', 'files.metadata.read', 'files.content.read', 'files.content.write'],
    pkce: true,
    scope_on_token: false,
    authorize_params: { token_access_type: 'offline' },
    export_folder_choice: true,
  },
  box: {
    authorize_url: 'https://account.box.com/api/oauth2/authorize',
    token_url: 'https://api.box.com/oauth2/token',
    revoke_url: 'https://api.box.com/oauth2/revoke',
    scopes: ['root_readwrite'],
    pkce: false,
    scope_on_token: false,
    authorize_params: {},
    export_folder_choice: true,
  },
};

export interface OAuthClientCredentials {
  readonly client_id: string;
  readonly client_secret: string;
}

export interface TokenSet {
  readonly access_token: string;
  /** Null when the provider sent none (keep the one already held). */
  readonly refresh_token: string | null;
  readonly expires_at: Date | null;
  readonly scope: string | null;
}

/** 32 random bytes, base64url: an OAuth state value or a PKCE code verifier. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function authorizeUrl(
  provider: CloudProviderId,
  creds: Pick<OAuthClientCredentials, 'client_id'>,
  args: { readonly redirect_uri: string; readonly state: string; readonly code_verifier: string },
): string {
  const spec = OAUTH_SPECS[provider];
  const u = new URL(spec.authorize_url);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', creds.client_id);
  u.searchParams.set('redirect_uri', args.redirect_uri);
  u.searchParams.set('state', args.state);
  if (spec.scopes.length > 0) u.searchParams.set('scope', spec.scopes.join(' '));
  if (spec.pkce) {
    u.searchParams.set('code_challenge', pkceChallenge(args.code_verifier));
    u.searchParams.set('code_challenge_method', 'S256');
  }
  for (const [k, v] of Object.entries(spec.authorize_params)) u.searchParams.set(k, v);
  return u.toString();
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

function tokenSetOf(body: TokenResponse, now: Date): TokenSet {
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new CloudProviderError('failed', null, 'token response had no access token');
  }
  const expires = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
  return {
    access_token: body.access_token,
    refresh_token: typeof body.refresh_token === 'string' && body.refresh_token.length > 0 ? body.refresh_token : null,
    expires_at: Number.isFinite(expires) && expires > 0 ? new Date(now.getTime() + expires * 1000) : null,
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

async function tokenRequest(provider: CloudProviderId, creds: OAuthClientCredentials, params: Record<string, string>, fetchFn: FetchLike, now: Date): Promise<TokenSet> {
  const spec = OAUTH_SPECS[provider];
  const form = new URLSearchParams({ ...params, client_id: creds.client_id, client_secret: creds.client_secret });
  if (spec.scope_on_token) form.set('scope', spec.scopes.join(' '));
  let res: Response;
  try {
    res = await call(fetchFn, spec.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    });
  } catch (e) {
    // A refused grant (expired / revoked refresh token, a reused code) is 400 invalid_grant:
    // the user has to connect again.
    if (e instanceof CloudProviderError && (e.status === 400 || e.status === 401)) throw new CloudProviderError('unauthorized', e.status, 'grant refused');
    throw e;
  }
  return tokenSetOf(await json<TokenResponse>(res), now);
}

export function exchangeCode(
  provider: CloudProviderId,
  creds: OAuthClientCredentials,
  args: { readonly code: string; readonly redirect_uri: string; readonly code_verifier: string },
  fetchFn: FetchLike,
  now: Date = new Date(),
): Promise<TokenSet> {
  return tokenRequest(
    provider,
    creds,
    {
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirect_uri,
      ...(OAUTH_SPECS[provider].pkce ? { code_verifier: args.code_verifier } : {}),
    },
    fetchFn,
    now,
  );
}

export function refreshAccessToken(provider: CloudProviderId, creds: OAuthClientCredentials, refresh_token: string, fetchFn: FetchLike, now: Date = new Date()): Promise<TokenSet> {
  return tokenRequest(provider, creds, { grant_type: 'refresh_token', refresh_token }, fetchFn, now);
}

/**
 * Revoke the grant at the provider (best effort; disconnect deletes the tokens either way).
 * Returns false when the provider has no revoke endpoint or the call failed.
 */
export async function revokeGrant(
  provider: CloudProviderId,
  creds: OAuthClientCredentials,
  tokens: { readonly access_token: string; readonly refresh_token: string | null },
  fetchFn: FetchLike,
): Promise<boolean> {
  const spec = OAUTH_SPECS[provider];
  if (spec.revoke_url === null) return false;
  try {
    if (provider === 'dropbox') {
      // Dropbox revokes the token that authenticates the call (and its refresh token).
      await call(fetchFn, spec.revoke_url, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}` } });
      return true;
    }
    const form = new URLSearchParams({ token: tokens.refresh_token ?? tokens.access_token });
    if (provider === 'box') {
      form.set('client_id', creds.client_id);
      form.set('client_secret', creds.client_secret);
    }
    await call(fetchFn, spec.revoke_url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    return true;
  } catch {
    return false;
  }
}
