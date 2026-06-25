import { randomBytes } from 'node:crypto';

// Domain-Enforcement P2b — the DNS-TXT verification status guard + token.
//
// Sibling to email-domain.ts (the P1 leaf util). The verification status is a
// String column on Tenant + this app-side guard — NOT a Prisma enum — mirroring
// the invite_status precedent (INVITE_STATUSES in tenant-user/invitation-token.ts).
//
// The 3-state machine (directive §5), all INFORMATIONAL in P2b (PO ruling (a) —
// VERIFIED gates nothing):
//   UNVERIFIED  the default for every row (pre-migration backfill + new tenants).
//   PENDING     a token has been minted; the tenant is expected to publish it in
//               DNS, then ask Aramo to re-check. Re-check on a no-match stays
//               PENDING (DNS not propagated yet — the common path, NOT an error).
//   VERIFIED    the published TXT record matched the stored token. STICKY — stays
//               VERIFIED even if the record later disappears (Lead ruling).
export const DOMAIN_VERIFICATION_STATUSES = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
] as const;
export type DomainVerificationStatus =
  (typeof DOMAIN_VERIFICATION_STATUSES)[number];

export function isDomainVerificationStatus(
  value: string,
): value is DomainVerificationStatus {
  return (DOMAIN_VERIFICATION_STATUSES as readonly string[]).includes(value);
}

// The number of random bytes in a verification token — the same 256-bit budget
// as the invitation token (INVITATION_TOKEN_BYTES).
const DOMAIN_TOKEN_BYTES = 32;

// Mint a verification token. Reuses the invitation-token RAW generation verbatim
// (randomBytes(32).toString('base64url') — high-entropy, URL-safe, node:crypto),
// but DELIBERATELY does NOT hash it (cf. hashInvitationToken). The inverted
// security model vs invites is intentional and correct: an invite token is a
// SECRET (hashed at rest, shown once); a DNS token is PUBLIC by design — the
// tenant publishes it in a TXT record — so it is stored RAW and proves DNS
// control, not secrecy. Re-checks compare the same raw token repeatedly.
export function generateDomainVerificationToken(): string {
  return randomBytes(DOMAIN_TOKEN_BYTES).toString('base64url');
}
