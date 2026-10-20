import { createHash, randomBytes } from 'node:crypto';

// DOC-3 R17/§250 — signing-session capability token. Modeled verbatim on
// libs/portal-identity/src/lib/portal-login-token.ts (G-3-4): the RAW token is
// emitted ONCE (in the signing link) and NEVER stored — only its sha256.base64url
// hash lives in SigningSession.token_hash. Kept local by convention so the
// pattern travels without a shared dependency.

export const SIGNING_TOKEN_BYTES = 32;
export const SIGNING_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (signing window)

export interface MintedSigningToken {
  raw: string;
  hash: string;
}

export function generateSigningToken(): MintedSigningToken {
  const raw = randomBytes(SIGNING_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashSigningToken(raw) };
}

export function hashSigningToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

export function signingSessionExpiresAt(now: Date): Date {
  return new Date(now.getTime() + SIGNING_SESSION_TTL_MS);
}
