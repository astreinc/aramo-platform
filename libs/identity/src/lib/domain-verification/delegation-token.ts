import { createHash, randomBytes } from 'node:crypto';

// Domain-Enforcement P3 §5 — the delegate link's token. The SECRET model (unlike
// the P2b DNS token, which is public by design): the signup / signing-link
// pattern — randomBytes(32) base64url, only the SHA-256 hash is stored
// (DomainVerificationDelegation.token_hash, unique), the raw value travels once
// in the emailed link's URL fragment and is posted back in a request body.

const DELEGATION_TOKEN_BYTES = 32;

// The grant's lifetime (§5: 7 days).
export const DELEGATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateDelegationToken(): string {
  return randomBytes(DELEGATION_TOKEN_BYTES).toString('base64url');
}

export function hashDelegationToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('base64url');
}

// The emailed link. The token is in the FRAGMENT (never sent to a server in the
// request line, never logged by a proxy); the delegate page posts it in a body.
export function buildDelegateLink(base: string, rawToken: string): string {
  return `${base.replace(/\/+$/, '')}/domain-verification#token=${encodeURIComponent(rawToken)}`;
}

// The delegate page lives in the Aramo Sign application (sign host), where the
// session-less delegate routes are proxied to apps/api (P3 §4 nginx exception).
// One origin serves every tenant, Sign-only or not: the delegate has no session,
// so no tenant host is needed. Resolution mirrors libs/sign signBaseUrl (inlined —
// libs/identity does not depend on @aramo/sign): ARAMO_SIGN_BASE_URL, then the two
// pre-S-2 names, else the production origin.
export function delegateLinkBase(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ['ARAMO_SIGN_BASE_URL', 'SIGN_WEB_BASE_URL', 'SIGN_SENDER_WEB_BASE_URL']) {
    const v = env[key]?.trim();
    if (v !== undefined && v !== '') return v.replace(/\/+$/, '');
  }
  return 'https://sign.aramo.ai';
}
