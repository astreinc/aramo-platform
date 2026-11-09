// The native sign-in flow (M-A1 §3.2-§3.3):
//   1. fresh PKCE verifier/challenge, state and nonce (memory only);
//   2. Cognito authorize URL for the chosen provider, opened in the OS auth session;
//   3. callback validated (exact redirect + constant-time state check);
//   4. code + verifier + redirect_uri + nonce + device POSTed to auth-service;
//   5. tokens stored in SecureStore by the SessionManager.
// Refusals surface as ApiError reasons (e.g. idp_not_permitted_for_tenant, C-9).
//
// Apple Go-Live A1 L-3/L-4 adds two uses of the same authorize step:
//   - linkProvider: path 1 (signed in), POST /auth/native/sign/link with the Bearer token;
//   - signInWithProvider(…, {linkHandle}): proof (a), the pending link rides on the token call.
// And R-5 (native Apple-first signup): appleSignupIdentity reads email + name from Cognito's
// ID token on the device and discards every token.
import type { LinkedResponse } from '../api/apple-contract-types';
import { clientError } from '../api/errors';
import type { FetchFn } from '../api/http';
import { base64Decode, utf8Decode } from '../util/bytes';
import type { AppEnv } from '../config/env';
import {
  buildAuthorizeUrl,
  parseAuthCallback,
  selectRedirectUri,
  type Provider,
} from './authorize';
import { expectCallback } from './callbackBus';
import type { DeviceDescriptor } from './installation';
import type { CodeExchange, NativeAuthApi } from './nativeAuthApi';
import { createAuthRequestSecrets, platformCrypto, type CryptoPort } from './pkce';
import type { SessionManager } from './session';

export type AuthSessionResult =
  | { readonly type: 'success'; readonly url: string }
  | { readonly type: string; readonly url?: undefined };

export interface SignInDeps {
  readonly env: Pick<AppEnv, 'cognitoDomain' | 'nativeClientId' | 'androidRedirect'>;
  readonly platform: string;
  readonly osVersion: string | number;
  readonly api: NativeAuthApi;
  readonly session: Pick<SessionManager, 'establish'>;
  readonly describeDevice: () => Promise<DeviceDescriptor>;
  /** expo-web-browser openAuthSessionAsync (ASWebAuthenticationSession / Custom Tabs). */
  readonly openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>;
  readonly crypto?: CryptoPort;
  /** How long to wait for a deep-link callback after the browser closes (Android race). */
  readonly lateCallbackMs?: number;
}

function wait(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** The callback's code plus the request secrets it must be redeemed with. */
interface AuthorizedCode {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly nonce: string;
}

type AuthorizeDeps = Pick<
  SignInDeps,
  'env' | 'platform' | 'osVersion' | 'openAuthSession' | 'crypto' | 'lateCallbackMs'
>;

/** Steps 1-3: PKCE secrets, the OS auth session for `provider`, and the validated callback. */
async function authorizeWithProvider(
  provider: Provider,
  deps: AuthorizeDeps,
): Promise<AuthorizedCode> {
  const { cognitoDomain, nativeClientId } = deps.env;
  if (!cognitoDomain || !nativeClientId) throw clientError('auth_not_configured');

  const secrets = await createAuthRequestSecrets(deps.crypto ?? platformCrypto);
  const redirectUri = selectRedirectUri(deps.platform, deps.osVersion, deps.env.androidRedirect);
  const authorizeUrl = buildAuthorizeUrl({
    cognitoDomain,
    clientId: nativeClientId,
    redirectUri,
    provider,
    state: secrets.state,
    nonce: secrets.nonce,
    codeChallenge: secrets.codeChallenge,
  });

  const late = expectCallback(redirectUri);
  let callbackUrl: string | null = null;
  try {
    const result = await deps.openAuthSession(authorizeUrl, redirectUri);
    if (result.type === 'success' && result.url) callbackUrl = result.url;
    else callbackUrl = await Promise.race([late.promise, wait(deps.lateCallbackMs ?? 1500)]);
  } finally {
    late.cancel();
  }
  if (!callbackUrl) throw clientError('auth_cancelled');

  const parsed = parseAuthCallback(callbackUrl, redirectUri, secrets.state);
  if (!parsed.ok)
    throw clientError(parsed.reason === 'invalid_callback' ? 'state_mismatch' : parsed.reason);
  return {
    code: parsed.code,
    codeVerifier: secrets.codeVerifier,
    redirectUri,
    nonce: secrets.nonce,
  };
}

async function exchangeBody(
  a: AuthorizedCode,
  describeDevice: () => Promise<DeviceDescriptor>,
): Promise<CodeExchange> {
  return {
    code: a.code,
    code_verifier: a.codeVerifier,
    redirect_uri: a.redirectUri,
    nonce: a.nonce,
    device: await describeDevice(),
  };
}

export interface SignInOptions {
  /** A1 L-4 proof (a): the pending-link handle (memory only) attached on this sign-in. */
  readonly linkHandle?: string;
}

export interface SignInOutcome {
  /** Signed in, but the pending link was not attached: the refusal reason. */
  readonly linkRefused: string | null;
}

export async function signInWithProvider(
  provider: Provider,
  deps: SignInDeps,
  options: SignInOptions = {},
): Promise<SignInOutcome> {
  const authorized = await authorizeWithProvider(provider, deps);
  const body = await exchangeBody(authorized, deps.describeDevice);
  const tokens = await deps.api.exchangeCode(
    options.linkHandle ? { ...body, link_handle: options.linkHandle } : body,
  );
  await deps.session.establish(tokens);
  return { linkRefused: tokens.link_refused ?? null };
}

export interface LinkDeps extends AuthorizeDeps {
  readonly describeDevice: () => Promise<DeviceDescriptor>;
  /** POST /auth/native/sign/link with the signed-in user's Bearer token (A1 L-4 path 1). */
  readonly link: (body: CodeExchange) => Promise<LinkedResponse>;
}

/** A1 L-3 path 1 (proof (c)): add `provider` as a sign-in method of the signed-in user. */
export async function linkProvider(provider: Provider, deps: LinkDeps): Promise<LinkedResponse> {
  const authorized = await authorizeWithProvider(provider, deps);
  return deps.link(await exchangeBody(authorized, deps.describeDevice));
}

/** What Apple shared, read from Cognito's ID token on the device (Apple Go-Live R-5). */
export interface AppleSignupIdentity {
  readonly email: string;
  readonly givenName: string | null;
  readonly familyName: string | null;
}

export interface AppleIdentityDeps extends AuthorizeDeps {
  /** A credential-free fetch for Cognito's public /oauth2/token endpoint. */
  readonly fetch: FetchFn;
}

function idTokenClaims(idToken: string): Record<string, unknown> | null {
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const v: unknown = JSON.parse(utf8Decode(base64Decode(part)));
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const claimText = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

/**
 * Apple Go-Live R-5 (native): run the existing PKCE flow with SignInWithApple, redeem the
 * code at Cognito's token endpoint (public client, PKCE, no secret), read email and name
 * from the ID token payload and discard every token. Not a verification and not a
 * sign-in: no Aramo session is created, the signup's email code proves the mailbox and the
 * later sign-in must carry the same verified email.
 */
export async function appleSignupIdentity(deps: AppleIdentityDeps): Promise<AppleSignupIdentity> {
  const a = await authorizeWithProvider('apple', deps);
  const { cognitoDomain, nativeClientId } = deps.env;
  if (!cognitoDomain || !nativeClientId) throw clientError('auth_not_configured');
  const form = (
    [
      ['grant_type', 'authorization_code'],
      ['client_id', nativeClientId],
      ['code', a.code],
      ['redirect_uri', a.redirectUri],
      ['code_verifier', a.codeVerifier],
    ] as const
  )
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  let res: Response;
  try {
    res = await deps.fetch(`https://${cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      credentials: 'omit',
      body: form,
    });
  } catch {
    throw clientError('network_unavailable');
  }
  if (!res.ok) throw clientError('code_exchange_rejected', res.status);
  let idToken: unknown;
  try {
    idToken = (JSON.parse(await res.text()) as { id_token?: unknown }).id_token;
  } catch {
    idToken = undefined;
  }
  // Only the ID token payload is read; the access and refresh tokens are dropped here.
  const claims = typeof idToken === 'string' ? idTokenClaims(idToken) : null;
  if (claims === null || claims['nonce'] !== a.nonce) throw clientError('state_mismatch');
  const email = claimText(claims['email']);
  if (email === null) throw clientError('code_exchange_rejected');
  return {
    email,
    givenName: claimText(claims['given_name']),
    familyName: claimText(claims['family_name']),
  };
}
