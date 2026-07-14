import { createHash, randomBytes } from 'node:crypto';

// Portal P1 PR-1 — the passwordless portal-login token pure util. Modeled on the
// TR-3 verification-token util (apps/api/src/talent-identity/verification-token.ts)
// verbatim, kept local by convention so the pattern travels without a shared
// dependency (the same way TR-3 cloned the invite-token util). The ONLY divergence
// from TR-3 is the TTL: 15 minutes here vs TR-3's 72 hours.
//
// The raw token is emitted ONCE (in the magic-link URL) and NEVER stored — only
// its sha256.base64url hash lives in PortalLoginToken.token_hash.

export const PORTAL_LOGIN_TOKEN_BYTES = 32;
export const PORTAL_LOGIN_TTL_MS = 15 * 60 * 1000;

/**
 * Generate a fresh portal-login token: a 32-byte base64url random raw secret and
 * its sha256.base64url hash. Return `{ raw, hash }` — the raw goes into the
 * emailed link, the hash into the DB.
 */
export function generatePortalLoginToken(): { raw: string; hash: string } {
  const raw = randomBytes(PORTAL_LOGIN_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashPortalLoginToken(raw) };
}

/** Hash a presented raw token for lookup/consume. sha256 → base64url. */
export function hashPortalLoginToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

/** The app-side expiry (15 minutes from `now`), applied at mint AND rotate. */
export function portalLoginExpiresAt(now: Date): Date {
  return new Date(now.getTime() + PORTAL_LOGIN_TTL_MS);
}
