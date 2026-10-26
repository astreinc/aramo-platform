// Builds the Cognito hosted-UI authorize request for the native client and validates
// the callback (M-A1 §3.1-§3.2). The request opens in the OS authentication session
// (ASWebAuthenticationSession / Custom Tabs); embedded webviews are prohibited.
import { NATIVE_FALLBACK_REDIRECT_URI, NATIVE_REDIRECT_URI } from '../config/env';
import { safeEqual } from './pkce';

export type Provider = 'google' | 'microsoft';

/** Cognito `identity_provider` names, matching the browser flow (auth.controller mapIdpHint). */
const COGNITO_IDP: Record<Provider, string> = { google: 'Google', microsoft: 'microsoft' };

export interface AuthorizeParams {
  readonly cognitoDomain: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly provider: Provider;
  readonly state: string;
  readonly nonce: string;
  readonly codeChallenge: string;
}

export function buildAuthorizeUrl(p: AuthorizeParams): string {
  if (!/^[a-z0-9.-]+$/i.test(p.cognitoDomain)) throw new Error('invalid Cognito domain');
  if (p.redirectUri !== NATIVE_REDIRECT_URI && p.redirectUri !== NATIVE_FALLBACK_REDIRECT_URI) {
    throw new Error('redirect URI is not a registered native callback');
  }
  const q: [string, string][] = [
    ['client_id', p.clientId],
    ['response_type', 'code'],
    ['redirect_uri', p.redirectUri],
    ['scope', 'openid email profile'],
    ['state', p.state],
    ['nonce', p.nonce],
    ['code_challenge', p.codeChallenge],
    ['code_challenge_method', 'S256'],
    ['identity_provider', COGNITO_IDP[p.provider]],
  ];
  return `https://${p.cognitoDomain}/oauth2/authorize?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

/**
 * Which registered callback this device can receive inside the auth session:
 * iOS 17.4+ intercepts https callbacks (host+path); older iOS can only match a custom
 * scheme. Android receives the verified App Link; 'custom' is the documented fallback
 * where App Link verification is unavailable (M-A1 §3.1).
 */
export function selectRedirectUri(
  platform: string,
  osVersion: string | number,
  androidRedirect: 'https' | 'custom',
): string {
  if (platform === 'ios') {
    const [maj = 0, min = 0] = String(osVersion)
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0);
    return maj > 17 || (maj === 17 && min >= 4)
      ? NATIVE_REDIRECT_URI
      : NATIVE_FALLBACK_REDIRECT_URI;
  }
  return androidRedirect === 'custom' ? NATIVE_FALLBACK_REDIRECT_URI : NATIVE_REDIRECT_URI;
}

export type CallbackResult =
  | { readonly ok: true; readonly code: string }
  | {
      readonly ok: false;
      readonly reason: 'state_mismatch' | 'authorization_denied' | 'invalid_callback';
    };

function queryOf(url: string): Map<string, string> {
  const out = new Map<string, string>();
  const q = url.split('#')[0]?.split('?')[1] ?? '';
  for (const part of q.split('&')) {
    if (!part) continue;
    const [k = '', v = ''] = part.split('=');
    try {
      out.set(decodeURIComponent(k.replace(/\+/g, ' ')), decodeURIComponent(v.replace(/\+/g, ' ')));
    } catch {
      out.set('__malformed__', '1');
    }
  }
  return out;
}

/** True when `url` is exactly the expected callback (scheme, host, path), ignoring the query. */
export function isCallbackFor(url: string, redirectUri: string): boolean {
  const base = url.split(/[?#]/)[0] ?? '';
  return base === redirectUri;
}

/** Validates the callback against the expected redirect and the in-memory `state`. */
export function parseAuthCallback(
  url: string,
  redirectUri: string,
  expectedState: string,
): CallbackResult {
  if (!isCallbackFor(url, redirectUri)) return { ok: false, reason: 'invalid_callback' };
  const q = queryOf(url);
  if (q.has('__malformed__')) return { ok: false, reason: 'invalid_callback' };
  const state = q.get('state') ?? '';
  if (!state || !safeEqual(state, expectedState)) return { ok: false, reason: 'state_mismatch' };
  if (q.has('error')) return { ok: false, reason: 'authorization_denied' };
  const code = q.get('code') ?? '';
  if (!/^[A-Za-z0-9._~-]{1,2048}$/.test(code)) return { ok: false, reason: 'invalid_callback' };
  return { ok: true, code };
}
