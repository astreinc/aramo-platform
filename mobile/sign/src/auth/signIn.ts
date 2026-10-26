// The native sign-in flow (M-A1 §3.2-§3.3):
//   1. fresh PKCE verifier/challenge, state and nonce (memory only);
//   2. Cognito authorize URL for the chosen provider, opened in the OS auth session;
//   3. callback validated (exact redirect + constant-time state check);
//   4. code + verifier + redirect_uri + nonce + device POSTed to auth-service;
//   5. tokens stored in SecureStore by the SessionManager.
// Refusals surface as ApiError reasons (e.g. idp_not_permitted_for_tenant, C-9).
import { clientError } from '../api/errors';
import type { AppEnv } from '../config/env';
import {
  buildAuthorizeUrl,
  parseAuthCallback,
  selectRedirectUri,
  type Provider,
} from './authorize';
import { expectCallback } from './callbackBus';
import type { DeviceDescriptor } from './installation';
import type { NativeAuthApi } from './nativeAuthApi';
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

export async function signInWithProvider(provider: Provider, deps: SignInDeps): Promise<void> {
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

  const tokens = await deps.api.exchangeCode({
    code: parsed.code,
    code_verifier: secrets.codeVerifier,
    redirect_uri: redirectUri,
    nonce: secrets.nonce,
    device: await deps.describeDevice(),
  });
  await deps.session.establish(tokens);
}
