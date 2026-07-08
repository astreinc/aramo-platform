// TR-3 B2 (§3.1) — LOCAL email-verification token utilities.
//
// The invitation-token *pattern* is reused here VERBATIM, but NOT imported:
// libs/identity's generateInvitationToken lives behind the identity module and
// carries an invitation-specific TTL. TR-3's verification flow owns its own
// pure utils so the pattern travels without an identity-lib dependency (the
// flow is talent-identity/, not identity/). Shape is byte-for-byte the same:
//   - a 32-byte random secret, base64url-encoded (the RAW token, mailed once);
//   - sha256(raw).base64url stored at rest (the raw token is NEVER persisted);
//   - a single-use, app-side-TTL request row the confirm path replay-guards.
//
// The ONLY intentional divergence from the invitation constant is the TTL: TR-3
// uses a 72h window (DDR §2 engine constant) vs the invite's 7 days.

import { createHash, randomBytes } from 'node:crypto';

// 32 bytes of entropy — the invitation-token width. base64url yields a 43-char
// URL-safe secret with no padding.
const VERIFICATION_TOKEN_BYTES = 32;

// Engine constant (DDR §2): a verification link is good for 72 hours. A resend
// rotates the secret in place and re-stamps expires_at from now (§3.1).
export const VERIFICATION_TTL_MS = 72 * 60 * 60 * 1000;

export interface GeneratedVerificationToken {
  // The high-entropy secret, mailed to the talent exactly once. Never stored.
  raw: string;
  // sha256(raw).base64url — the at-rest lookup key (token_hash @unique).
  hash: string;
}

// Mint a fresh (raw, hash) pair. Called on request and on every resend (rotate).
export function generateVerificationToken(): GeneratedVerificationToken {
  const raw = randomBytes(VERIFICATION_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashVerificationToken(raw) };
}

// Deterministic at-rest hash of a raw token — the confirm path hashes the
// presented token and looks the row up by this value (the token is authority).
export function hashVerificationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

// The absolute expiry for a token minted `now`.
export function verificationExpiresAt(now: Date): Date {
  return new Date(now.getTime() + VERIFICATION_TTL_MS);
}
