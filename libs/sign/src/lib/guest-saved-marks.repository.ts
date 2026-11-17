import { Injectable } from '@nestjs/common';

import type { SessionContext } from './esign.service.js';
import { PrismaService } from './prisma/prisma.service.js';
import { recipientKindOf } from './domain/recipients.js';

// Aramo-Sign-Mobile-Amendment-M-A15-Guest-Saved-Signature-v1_0 §3 — whose saved
// signature a signing session may use. The guest page stays session-free: the server
// decides from the signing session alone.
//
//   §3.1 SELF sessions          → the session's authenticated_user_id (no email match).
//        INBOX sessions         → (typed divergence D-1 from §3.1) the session row never
//                                 records its user (CHECK SigningSession_authenticated_user_check:
//                                 authenticated_user_id only for SELF). An inbox session is
//                                 issued only to a signed-in user whose verified email equals
//                                 the recipient's (inbox binding principle), so that user is
//                                 resolved by the §3.2 verified-email match and treated as
//                                 signed in (may save; the opt-out does not apply).
//   §3.2 LINK / legacy (NULL)   → the ONE active Aramo user whose email (lower(btrim))
//                                 equals the signer's AND is verified by (a) a federated
//                                 link whose email_snapshot equals it, or (b) a Personal
//                                 signup with email_verified_at whose owner is that user.
//                                 Read only; a deliberate, narrow exception to the inbox
//                                 binding principle ("never an email match alone").
//   §3.3 never                  → HOSTED sessions; recipients other than SIGNER / WITNESS.
//
// The marks are read under the user's OWN tenant (User.tenant_id; IC-1 one tenant per user).

export type SavedMarksBinding =
  | { kind: 'signed_in'; user_id: string; tenant_id: string }
  | { kind: 'email_match'; user_id: string; tenant_id: string };

type RawClient = Pick<PrismaService, '$queryRawUnsafe'>;

const OFFERED_KINDS = new Set(['SIGNER', 'WITNESS']);

/** The active user's own tenant, or null (inactive, deactivated or unknown). */
export async function activeUserTenant(client: RawClient, user_id: string): Promise<string | null> {
  const rows = await client.$queryRawUnsafe<Array<{ tenant_id: string | null }>>(
    `SELECT u.tenant_id::text AS tenant_id
       FROM identity."User" u
      WHERE u.id = $1::uuid AND u.is_active = true AND u.deactivated_at IS NULL`,
    user_id,
  );
  return rows[0]?.tenant_id ?? null;
}

/**
 * §3.2 — the one active user whose verified email equals `email` (normalized), with
 * their own tenant. Null when none, or when more than one qualifies.
 */
export async function verifiedUserByEmail(client: RawClient, email: string): Promise<{ user_id: string; tenant_id: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const rows = await client.$queryRawUnsafe<Array<{ user_id: string; tenant_id: string | null }>>(
    `SELECT u.id::text AS user_id, u.tenant_id::text AS tenant_id
       FROM identity."User" u
      WHERE lower(btrim(u.email)) = $1
        AND u.is_active = true
        AND u.deactivated_at IS NULL
        AND (
          EXISTS (
            SELECT 1
              FROM identity."ExternalIdentity" e
              JOIN identity."ExternalIdentityIdp" p ON p.external_identity_id = e.id
             WHERE e.user_id = u.id
               AND p.idp IN ('google', 'microsoft', 'apple')
               AND e.email_snapshot IS NOT NULL
               AND lower(btrim(e.email_snapshot)) = lower(btrim(u.email))
          )
          OR EXISTS (
            SELECT 1
              FROM identity."PersonalSignupRequest" s
             WHERE s.owner_user_id = u.id
               AND s.email_verified_at IS NOT NULL
               AND lower(btrim(s.email)) = lower(btrim(u.email))
          )
        )
      LIMIT 2`,
    normalized,
  );
  if (rows.length !== 1) return null;
  const r = rows[0];
  if (r === undefined || r.tenant_id === null) return null;
  return { user_id: r.user_id, tenant_id: r.tenant_id };
}

@Injectable()
export class GuestSavedMarksRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** §3 — the user whose saved marks this signing session may use, or null. */
  async bindingFor(ctx: SessionContext): Promise<SavedMarksBinding | null> {
    const session = await this.prisma.signingSession.findFirst({
      where: { id: ctx.session_id, tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id, signer_id: ctx.signer_id },
      select: { origin: true, authenticated_user_id: true },
    });
    if (session === null) return null;
    const signer = await this.prisma.signer.findFirst({
      where: { id: ctx.signer_id, tenant_id: ctx.tenant_id, envelope_id: ctx.envelope_id },
      select: { email: true, recipient_kind: true },
    });
    if (signer === null || !OFFERED_KINDS.has(recipientKindOf(signer))) return null;
    // §3.3 — never on an in-person (hosted) session: the host holds the device.
    if (session.origin === 'HOSTED') return null;
    if (session.origin === 'SELF') {
      if (session.authenticated_user_id === null) return null;
      const tenant_id = await activeUserTenant(this.prisma, session.authenticated_user_id);
      return tenant_id === null ? null : { kind: 'signed_in', user_id: session.authenticated_user_id, tenant_id };
    }
    // §3.2 — an emailed link (LINK) or a legacy session (NULL); D-1 — an INBOX session.
    if (session.origin !== null && session.origin !== 'LINK' && session.origin !== 'INBOX') return null;
    if (signer.email === null) return null;
    const match = await verifiedUserByEmail(this.prisma, signer.email);
    if (match === null) return null;
    return session.origin === 'INBOX' ? { kind: 'signed_in', ...match } : { kind: 'email_match', ...match };
  }
}
