import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { MICROSOFT_DELEGATED_SCOPES, assertLeastPrivilegeScopes } from './graph-scopes.js';

// COMM-C2B — delegated OAuth authorization-code + PKCE state (directive R2).
//
// Mirrors the auth-core PkceService crypto approach (AES-256-GCM state envelope,
// S256 PKCE) but is DEDICATED to the Microsoft delegated flow so Aramo login-auth
// and third-party delegated-authz stay decoupled. The browser NEVER receives the
// PKCE verifier or any token; the encrypted `state` is the only client-held value
// and it is opaque + integrity-protected (GCM tag) + TTL-bounded.

export const MICROSOFT_LOGIN_AUTHORITY = 'https://login.microsoftonline.com';
// 'organizations' = work/school (Microsoft Entra) accounts only — never personal
// MSAs; per-user delegated identity is preserved (R5).
export const MICROSOFT_DEFAULT_AUTHORITY_TENANT = 'organizations';
export const MICROSOFT_OAUTH_STATE_TTL_SECONDS = 600;
const STATE_KEY_ENV = 'MSGRAPH_OAUTH_STATE_KEY';

export interface MicrosoftOAuthStatePayload {
  readonly tenant_id: string; // Aramo tenant
  readonly recruiter_id: string; // Aramo user/recruiter
  readonly connection_id: string; // IntegrationConnection id
  readonly verifier: string; // PKCE code_verifier (server-only)
  readonly nonce: string; // CSRF nonce
  readonly issued_at: number; // epoch seconds
}

export interface MicrosoftPkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly nonce: string;
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const VERIFIER_BYTES = 64;
const NONCE_BYTES = 32;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}
function fromB64url(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

export class MicrosoftOAuthStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MicrosoftOAuthStateError';
  }
}

/** RFC-7636 S256 PKCE pair + a CSRF nonce. All server-side; browser sees none. */
export function generateMicrosoftPkce(): MicrosoftPkcePair {
  const verifier = b64url(randomBytes(VERIFIER_BYTES));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const nonce = b64url(randomBytes(NONCE_BYTES));
  return { verifier, challenge, nonce };
}

function loadKey(): Buffer {
  const v = process.env[STATE_KEY_ENV];
  if (v === undefined || v.length === 0) {
    throw new MicrosoftOAuthStateError(`${STATE_KEY_ENV} is not configured`);
  }
  const buf = fromB64url(v);
  if (buf.length !== KEY_BYTES) {
    throw new MicrosoftOAuthStateError(
      `${STATE_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${buf.length})`,
    );
  }
  return buf;
}

export function encryptMicrosoftOAuthState(payload: MicrosoftOAuthStatePayload): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return b64url(Buffer.concat([iv, ct, tag]));
}

export function decryptMicrosoftOAuthState(cipherText: string): MicrosoftOAuthStatePayload {
  const key = loadKey();
  const raw = fromB64url(cipherText);
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new MicrosoftOAuthStateError('state_decrypt_failed');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ct = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new MicrosoftOAuthStateError('state_decrypt_failed');
  }
  return JSON.parse(plain.toString('utf8')) as MicrosoftOAuthStatePayload;
}

/** Whether an encrypted state has passed its TTL (replay/staleness guard). */
export function isMicrosoftOAuthStateExpired(
  payload: MicrosoftOAuthStatePayload,
  nowEpochSeconds: number,
  ttlSeconds = MICROSOFT_OAUTH_STATE_TTL_SECONDS,
): boolean {
  return payload.issued_at + ttlSeconds < nowEpochSeconds;
}

export interface BuildAuthorizeUrlArgs {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly encryptedState: string;
  readonly codeChallenge: string;
  readonly authorityTenant?: string;
  readonly loginAuthority?: string;
  readonly scopes?: readonly string[];
}

/**
 * Build the Microsoft authorize URL. R8 fail-closed: the scope list is asserted
 * against the least-privilege set BEFORE the URL is emitted, so a widened scope
 * can never reach Microsoft.
 */
export function buildMicrosoftAuthorizeUrl(args: BuildAuthorizeUrlArgs): string {
  const scopes = args.scopes ?? MICROSOFT_DELEGATED_SCOPES;
  assertLeastPrivilegeScopes(scopes);
  const authority = args.loginAuthority ?? MICROSOFT_LOGIN_AUTHORITY;
  const tenant = args.authorityTenant ?? MICROSOFT_DEFAULT_AUTHORITY_TENANT;
  const url = new URL(`${authority}/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', args.encryptedState);
  url.searchParams.set('code_challenge', args.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export function buildMicrosoftTokenEndpoint(
  authorityTenant?: string,
  loginAuthority?: string,
): string {
  const authority = loginAuthority ?? MICROSOFT_LOGIN_AUTHORITY;
  const tenant = authorityTenant ?? MICROSOFT_DEFAULT_AUTHORITY_TENANT;
  return `${authority}/${tenant}/oauth2/v2.0/token`;
}
