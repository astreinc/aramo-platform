import { createHmac, createPrivateKey, hkdfSync, randomBytes, sign as cryptoSign, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DEFAULT_SIGN_BASE_URL, signBaseUrl } from '@aramo/sign';

// Apple Go-Live R-8 / W6 — deleting an Apple-linked account revokes the user's Sign in with
// Apple tokens (App Store guideline 5.1.1(v)). The app re-authenticates with Apple DIRECTLY
// (not through Cognito) to get a one-time authorization code:
//   iOS          the native Apple sheet → POST /v1/sign/me/apple/revoke {authorization_code, client: 'ios'}
//   web/Android  GET /v1/sign/me/apple/revoke/start → Apple authorize (Services ID, form_post)
//                → POST /v1/sign/me/apple/revoke/callback {code, state} → 302 <return>?apple_revoked=1|0
// The code is exchanged at appleid.apple.com/auth/token with a client-secret JWT (ES256, the
// Sign in with Apple key), then the refresh token is revoked at /auth/revoke.
//
// Best effort: every failure is logged as an outcome code only (never a code, token, key or
// Apple response body) and never blocks the deletion. Nothing from Apple is stored.
//
// Configuration (all unset ⇒ "apple revoke unavailable", no call is made):
//   SIGN_APPLE_SIWA_TEAM_ID           the Apple developer team id (JWT iss)
//   SIGN_APPLE_SIWA_KEY_ID            the Sign in with Apple key id (JWT kid)
//   SIGN_APPLE_SIWA_PRIVATE_KEY_B64   base64 of the downloaded .p8 key (PKCS#8 PEM)
//   SIGN_APPLE_SIWA_SERVICES_ID       the Services ID (client_id for web and Android)
//   SIGN_APPLE_BUNDLE_ID              the app bundle id (client_id for iOS; shared with store billing)
//
// The `state` of the web/Android redirect is HMAC-SHA256 signed {user_id, return, exp, nonce}
// (10 minutes). Its key is derived with HKDF-SHA256 from the configured Sign in with Apple key
// under a distinct label, so it needs no extra secret and exists exactly when the feature does.
// The callback is a cross-site form_post from appleid.apple.com: the session cookie may not
// travel with it, so the user is bound by the signed state, not by the cookie.

export const APPLE_AUTH_ORIGIN = 'https://appleid.apple.com';
export const APPLE_TOKEN_URL = `${APPLE_AUTH_ORIGIN}/auth/token`;
export const APPLE_REVOKE_URL = `${APPLE_AUTH_ORIGIN}/auth/revoke`;
export const APPLE_AUTHORIZE_URL = `${APPLE_AUTH_ORIGIN}/auth/authorize`;
export const APPLE_REVOKE_CALLBACK_PATH = '/v1/sign/me/apple/revoke/callback';
export const APPLE_REVOKE_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_KEY_LABEL = 'aramo-sign/apple-revoke-state/v1';
const HTTP_TIMEOUT_MS = 5_000;
const CLIENT_SECRET_TTL_S = 5 * 60;
const MAX_RETURN_LENGTH = 512;
const MAX_STATE_LENGTH = 2048;
const MAX_CODE_LENGTH = 1024;

export type AppleRevokeClient = 'ios' | 'web';

export interface AppleSiwaConfig {
  team_id: string;
  key_id: string;
  private_key_pem: string;
  services_id: string | null;
  bundle_id: string | null;
}

export type AppleRevokeOutcome =
  | 'revoked'
  | 'unavailable'
  | 'invalid_input'
  | 'token_exchange_failed'
  | 'token_exchange_error'
  | 'no_token'
  | 'revoke_failed'
  | 'revoke_error';

interface AppleStateClaims {
  user_id: string;
  return: string;
  exp: number;
  nonce: string;
}

const val = (env: NodeJS.ProcessEnv, k: string): string | null => {
  const v = env[k]?.trim();
  return v === undefined || v === '' ? null : v;
};

/** The Sign in with Apple configuration, or null when the team, key id or key is missing/malformed. */
export function appleSiwaConfig(env: NodeJS.ProcessEnv = process.env): AppleSiwaConfig | null {
  const team_id = val(env, 'SIGN_APPLE_SIWA_TEAM_ID');
  const key_id = val(env, 'SIGN_APPLE_SIWA_KEY_ID');
  const keyB64 = val(env, 'SIGN_APPLE_SIWA_PRIVATE_KEY_B64');
  if (team_id === null || key_id === null || keyB64 === null) return null;
  const private_key_pem = Buffer.from(keyB64, 'base64').toString('utf8');
  if (!private_key_pem.includes('PRIVATE KEY')) return null;
  return { team_id, key_id, private_key_pem, services_id: val(env, 'SIGN_APPLE_SIWA_SERVICES_ID'), bundle_id: val(env, 'SIGN_APPLE_BUNDLE_ID') };
}

/** ios → the bundle id (native sheet); web (and Android, which uses the web redirect) → the Services ID. */
export function appleClientId(config: AppleSiwaConfig, client: AppleRevokeClient): string | null {
  return client === 'ios' ? config.bundle_id : config.services_id;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

/** The client secret: an ES256 JWT {iss team, iat, exp, aud appleid.apple.com, sub client_id}, kid = key id. */
export function appleClientSecret(config: AppleSiwaConfig, client_id: string, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: config.key_id }));
  const claims = b64url(JSON.stringify({ iss: config.team_id, iat: nowSeconds, exp: nowSeconds + CLIENT_SECRET_TTL_S, aud: APPLE_AUTH_ORIGIN, sub: client_id }));
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), { key: createPrivateKey(config.private_key_pem), dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

/**
 * A same-origin relative path, or null. Refused: absolute and scheme-relative URLs (`//`,
 * `/\`), backslashes, control characters, fragments and anything over 512 characters.
 */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_LENGTH) return null;
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f#]/.test(value)) return null;
  return value;
}

export function withRevokedFlag(path: string, revoked: boolean): string {
  return `${path}${path.includes('?') ? '&' : '?'}apple_revoked=${revoked ? '1' : '0'}`;
}

function stateKey(config: AppleSiwaConfig): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(config.private_key_pem, 'utf8'), Buffer.alloc(0), Buffer.from(STATE_KEY_LABEL, 'utf8'), 32));
}

export function mintAppleRevokeState(config: AppleSiwaConfig, user_id: string, returnPath: string, now: Date = new Date()): string {
  const claims: AppleStateClaims = { user_id, return: returnPath, exp: now.getTime() + APPLE_REVOKE_STATE_TTL_MS, nonce: randomBytes(16).toString('base64url') };
  const body = b64url(JSON.stringify(claims));
  return `${body}.${createHmac('sha256', stateKey(config)).update(body).digest('base64url')}`;
}

/** The claims of a state this service signed, unexpired, with a safe return path; null otherwise (one answer). */
export function openAppleRevokeState(config: AppleSiwaConfig, state: unknown, now: Date = new Date()): AppleStateClaims | null {
  if (typeof state !== 'string' || state.length === 0 || state.length > MAX_STATE_LENGTH) return null;
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, mac] = parts as [string, string];
  const want = createHmac('sha256', stateKey(config)).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof claims !== 'object' || claims === null) return null;
  const c = claims as Partial<AppleStateClaims>;
  if (typeof c.user_id !== 'string' || typeof c.nonce !== 'string' || typeof c.exp !== 'number') return null;
  if (c.exp <= now.getTime()) return null;
  if (safeReturnPath(c.return) === null) return null;
  return c as AppleStateClaims;
}

export function appleRevokeRedirectUri(env: NodeJS.ProcessEnv = process.env): string {
  return `${signBaseUrl(env) ?? DEFAULT_SIGN_BASE_URL}${APPLE_REVOKE_CALLBACK_PATH}`;
}

async function postForm(url: string, form: Record<string, string>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
}

@Injectable()
export class SignAppleRevokeService {
  private readonly log = new Logger(SignAppleRevokeService.name);

  /** POST /v1/sign/me/apple/revoke — best effort; the caller always answers 202. */
  async revokeFromApp(body: { authorization_code?: unknown; client?: unknown }): Promise<AppleRevokeOutcome> {
    const client = body.client === 'ios' || body.client === 'web' ? body.client : null;
    const code = body.authorization_code;
    if (client === null || typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) return this.done('invalid_input', client ?? 'unknown');
    // A native (iOS) code was issued without a redirect_uri; a web code with ours.
    return this.exchangeAndRevoke(code, client, client === 'web' ? appleRevokeRedirectUri() : null);
  }

  /**
   * GET /v1/sign/me/apple/revoke/start — the Apple authorize URL for the web/Android code, or
   * null when the feature is not configured (the caller then returns straight to `<return>?apple_revoked=0`).
   */
  authorizeUrl(user_id: string, returnPath: string, now: Date = new Date()): string | null {
    const config = appleSiwaConfig();
    if (config === null || config.services_id === null) {
      this.log.log('apple revoke unavailable');
      return null;
    }
    const q = new URLSearchParams({
      client_id: config.services_id,
      redirect_uri: appleRevokeRedirectUri(),
      response_type: 'code',
      response_mode: 'form_post',
      state: mintAppleRevokeState(config, user_id, returnPath, now),
    });
    return `${APPLE_AUTHORIZE_URL}?${q.toString()}`;
  }

  /**
   * POST /v1/sign/me/apple/revoke/callback — verify the state, then revoke. Returns the relative
   * path to redirect to; a state that does not verify (bad, expired, unconfigured) returns to `/`.
   */
  async callback(body: { code?: unknown; state?: unknown }, now: Date = new Date()): Promise<string> {
    const config = appleSiwaConfig();
    const claims = config === null ? null : openAppleRevokeState(config, body.state, now);
    if (claims === null) {
      this.log.warn('apple revoke callback outcome=state_invalid');
      return withRevokedFlag('/', false);
    }
    const code = body.code;
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_LENGTH) {
      // The user cancelled at Apple (Apple posts `error` instead of a code), or a malformed post.
      this.done('invalid_input', 'web');
      return withRevokedFlag(claims.return, false);
    }
    const outcome = await this.exchangeAndRevoke(code, 'web', appleRevokeRedirectUri());
    return withRevokedFlag(claims.return, outcome === 'revoked');
  }

  private async exchangeAndRevoke(code: string, client: AppleRevokeClient, redirect_uri: string | null): Promise<AppleRevokeOutcome> {
    const config = appleSiwaConfig();
    const client_id = config === null ? null : appleClientId(config, client);
    if (config === null || client_id === null) {
      this.log.log('apple revoke unavailable');
      return 'unavailable';
    }
    let client_secret: string;
    try {
      client_secret = appleClientSecret(config, client_id, Math.floor(Date.now() / 1000));
    } catch {
      return this.done('unavailable', client);
    }

    let token: string | null = null;
    let hint: 'refresh_token' | 'access_token' = 'refresh_token';
    try {
      const res = await postForm(APPLE_TOKEN_URL, {
        client_id,
        client_secret,
        code,
        grant_type: 'authorization_code',
        ...(redirect_uri !== null ? { redirect_uri } : {}),
      });
      if (!res.ok) return this.done('token_exchange_failed', client, res.status);
      const json = (await res.json()) as { refresh_token?: unknown; access_token?: unknown };
      if (typeof json.refresh_token === 'string' && json.refresh_token !== '') token = json.refresh_token;
      else if (typeof json.access_token === 'string' && json.access_token !== '') {
        token = json.access_token;
        hint = 'access_token';
      }
    } catch {
      return this.done('token_exchange_error', client);
    }
    if (token === null) return this.done('no_token', client);

    try {
      const res = await postForm(APPLE_REVOKE_URL, { client_id, client_secret, token, token_type_hint: hint });
      if (!res.ok) return this.done('revoke_failed', client, res.status);
    } catch {
      return this.done('revoke_error', client);
    }
    return this.done('revoked', client);
  }

  // Outcome codes only: never the code, a token, the key or Apple's response body.
  private done(outcome: AppleRevokeOutcome, client: string, status?: number): AppleRevokeOutcome {
    const line = `apple revoke outcome=${outcome} client=${client}${status !== undefined ? ` status=${status}` : ''}`;
    if (outcome === 'revoked') this.log.log(line);
    else this.log.warn(line);
    return outcome;
  }
}
