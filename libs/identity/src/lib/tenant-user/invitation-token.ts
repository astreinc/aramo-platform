import { createHash, randomBytes } from 'node:crypto';

// Invite-S2 (Pattern-2) — invitation token primitives.
//
// Mirrors the program's existing token conventions:
//   - pkce.service.ts / refresh-orchestrator.service.ts generate raw tokens
//     as `randomBytes(N).toString('base64url')`.
//   - auth_storage refresh tokens persist `sha256(raw)` (base64url) at rest,
//     never the raw token.
//
// The raw token is embedded in the invite-email link and returned to the
// caller exactly ONCE; only its hash is persisted on the Invitation row.
// Acceptance re-derives the hash from the URL-supplied raw token and looks
// the row up by the @unique token_hash index.

const INVITATION_TOKEN_BYTES = 32;

// The per-tenant 3-state invite machine. String + this guard (NOT a Prisma
// enum) per the repo convention. ACTIVE is the column default for every
// pre-S2 row; the no-sub invite create writes INVITED, acceptance writes
// ACCEPTED, the reconcile-spine first-login hook writes ACTIVE.
export const INVITE_STATUSES = ['INVITED', 'ACCEPTED', 'ACTIVE'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

export function isInviteStatus(value: string): value is InviteStatus {
  return (INVITE_STATUSES as readonly string[]).includes(value);
}

// Hash a raw token for storage / lookup. SHA-256 → base64url, matching the
// auth_storage refresh-token convention (sha256Base64Url).
export function hashInvitationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url');
}

// Generate a fresh invite token: a high-entropy raw token (returned once)
// plus its storage hash. The caller persists `hash` and emails `raw`.
export function generateInvitationToken(): { raw: string; hash: string } {
  const raw = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashInvitationToken(raw) };
}

// Default invite TTL (7 days). Computed app-side at issue time and written to
// Invitation.expires_at, mirroring how the refresh-token path sets an
// explicit expires_at rather than relying on a DB default.
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
