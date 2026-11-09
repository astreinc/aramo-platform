import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { IdentityAuditService } from '../audit/identity-audit.service.js';
import { idpAllowedForTenantKind, normalizeIdp, type FederatedIdp } from '../identity-provider-policy.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeEmail } from '../util/email-domain.js';

import {
  LINK_OTP_MAX_ATTEMPTS,
  LINK_OTP_MAX_SENDS_PER_DAY,
  LINK_OTP_TTL_MS,
  checkLinkOtp,
  generateLinkOtp,
  hashLinkOtp,
  mayResendLinkOtp,
} from './link-otp.js';

// Aramo Sign Apple Platform Go-Live, Amendment A1 (LOCKED) — Proven Account Linking.
//
// L-1 (AUTH-SIGNIN-1 R2 amended): email equality alone never adds a provider to a
// user. A second (or third) provider identity is attached only after the user
// proves the account in the same flow:
//   (a) existing_provider — signing in with a provider already linked to it;
//   (b) email_code        — a code sent to the account email, entered now;
//   (c) signed_in         — being signed in when the link starts (path 1).
//
// L-2: a denied sign-in (user_not_provisioned / idp_identity_conflict) with a
// valid token and a known provider writes a PendingIdentityLink: only the hash of
// a random 32-byte handle is stored, 10-minute expiry, single use. No session and
// no link are created at that point.
//
// L-5: ONE attach function serves the three paths (attachIdentity). It refuses
// identity_already_linked / idp_already_linked / idp_not_permitted_for_tenant /
// user_inactive and, on success, writes ExternalIdentity + ExternalIdentityIdp and
// the audit event identity.external_identity.linked (reason user_proven_link,
// proof). The security email is the caller's (auth-service sends it through its
// own email port with the returned account email).
//
// L-8: expired rows are deleted on each write (expires_at < now() - 1 day).

export const PENDING_LINK_TTL_MS = 10 * 60 * 1000;
const PENDING_LINK_RETENTION_MS = 24 * 60 * 60 * 1000;
const HANDLE_BYTES = 32;

export type PendingLinkReason = 'user_not_provisioned' | 'idp_identity_conflict';
export type LinkProof = 'existing_provider' | 'email_code' | 'signed_in';
export type AttachRefusalReason =
  | 'identity_already_linked'
  | 'idp_already_linked'
  | 'idp_not_permitted_for_tenant'
  | 'user_inactive'
  | 'link_expired';

export type AttachOutcome =
  | { ok: true; user_id: string; idp: FederatedIdp; account_email: string }
  | { ok: false; reason: AttachRefusalReason };

export type EmailProofVerifyOutcome =
  | AttachOutcome
  | { ok: false; reason: 'code_invalid'; attempts_remaining: number }
  | { ok: false; reason: 'code_expired' | 'code_attempts_exceeded' };

export interface PendingIdentity {
  provider: string;
  provider_subject: string;
  idp: FederatedIdp;
  email_snapshot: string | null;
}

export interface SignInMethod {
  idp: FederatedIdp;
  email_snapshot: string | null;
  linked_at: Date;
}

export type RemoveSignInMethodOutcome =
  | { ok: true; user_id: string; idp: FederatedIdp; account_email: string }
  | { ok: false; reason: 'last_sign_in_method' | 'sign_in_method_not_found' };

/** The stored form of a pending-link handle (the handle itself is never stored). */
export function hashLinkHandle(handle: string): string {
  return createHash('sha256').update(handle, 'utf8').digest('base64url');
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

@Injectable()
export class IdentityLinkService {
  private readonly logger = new Logger(IdentityLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: IdentityAuditService,
  ) {}

  /** L-2 — record a denied sign-in's identity; returns the one-time handle. */
  async createPendingLink(
    input: PendingIdentity & { reason: PendingLinkReason; matched_user_id: string | null },
    now: Date = new Date(),
  ): Promise<{ handle: string; expires_at: Date }> {
    // L-8 — opportunistic cleanup on each write.
    await this.prisma.pendingIdentityLink.deleteMany({
      where: { expires_at: { lt: new Date(now.getTime() - PENDING_LINK_RETENTION_MS) } },
    });
    const handle = randomBytes(HANDLE_BYTES).toString('base64url');
    const expires_at = new Date(now.getTime() + PENDING_LINK_TTL_MS);
    await this.prisma.pendingIdentityLink.create({
      data: {
        id: uuidv7(),
        handle_hash: hashLinkHandle(handle),
        provider: input.provider,
        provider_subject: input.provider_subject,
        idp: input.idp,
        email_snapshot: input.email_snapshot,
        reason: input.reason,
        matched_user_id: input.reason === 'idp_identity_conflict' ? input.matched_user_id : null,
        expires_at,
      },
    });
    return { handle, expires_at };
  }

  /**
   * L-5 — the one attach policy for all three proofs. The caller has already
   * proven that `user_id` is the person in front of it.
   */
  async attachIdentity(input: PendingIdentity & { user_id: string; proof: LinkProof }): Promise<AttachOutcome> {
    const idp = normalizeIdp(input.idp);
    if (idp === null || idp === 'ambiguous') return { ok: false, reason: 'idp_not_permitted_for_tenant' };
    let outcome: AttachOutcome;
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // One attach at a time per user, so two concurrent attaches of the same
        // provider cannot both pass the idp_already_linked check.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`identity_link:${input.user_id}`}))`;
        const user = await tx.user.findUnique({
          where: { id: input.user_id },
          select: { id: true, email: true, is_active: true, deactivated_at: true, tenant_id: true },
        });
        if (user === null || !user.is_active || user.deactivated_at !== null) {
          return { ok: false, reason: 'user_inactive' } as const;
        }
        const taken = await tx.externalIdentity.findUnique({
          where: { provider_provider_subject: { provider: input.provider, provider_subject: input.provider_subject } },
          select: { id: true },
        });
        if (taken !== null) return { ok: false, reason: 'identity_already_linked' } as const;
        const held = await tx.$queryRaw<{ idp: string }[]>`
          SELECT p.idp FROM "identity"."ExternalIdentityIdp" p
          JOIN "identity"."ExternalIdentity" e ON e.id = p.external_identity_id
          WHERE e.user_id = ${user.id}::uuid AND p.idp = ${idp}`;
        if (held.length > 0) return { ok: false, reason: 'idp_already_linked' } as const;
        const [tenant, policy] = await Promise.all([
          tx.tenant.findUnique({ where: { id: user.tenant_id }, select: { kind: true, identity_provider: true } }),
          tx.tenantIdentityProviderPolicy.findUnique({ where: { tenant_id: user.tenant_id }, select: { tenant_id: true } }),
        ]);
        const kind = tenant?.kind ?? null;
        // PERSONAL: {google, apple} only. BUSINESS in the enforced cohort with a
        // pin: company policy wins (only the pinned provider).
        if (!idpAllowedForTenantKind(kind, idp)) return { ok: false, reason: 'idp_not_permitted_for_tenant' } as const;
        const pin = tenant?.identity_provider ?? null;
        if (kind !== 'PERSONAL' && policy !== null && pin !== null && pin.trim().toLowerCase() !== idp) {
          return { ok: false, reason: 'idp_not_permitted_for_tenant' } as const;
        }
        const link = await tx.externalIdentity.create({
          data: {
            id: uuidv7(),
            provider: input.provider,
            provider_subject: input.provider_subject,
            user_id: user.id,
            email_snapshot: input.email_snapshot,
          },
          select: { id: true },
        });
        await tx.externalIdentityIdp.create({ data: { external_identity_id: link.id, idp } });
        return { ok: true, user_id: user.id, idp, account_email: user.email } as const;
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { ok: false, reason: 'identity_already_linked' };
      throw err;
    }
    if (outcome.ok) {
      await this.audit.writeGlobalEvent({
        event_type: 'identity.external_identity.linked',
        actor_type: 'user',
        actor_id: outcome.user_id,
        subject_id: outcome.user_id,
        payload: {
          provider: input.provider,
          provider_subject: input.provider_subject,
          reason: 'user_proven_link',
          proof: input.proof,
          idp,
        },
      });
    } else {
      this.logger.warn(JSON.stringify({ event: 'identity.link_attach', outcome: outcome.reason, idp, proof: input.proof }));
    }
    return outcome;
  }

  /**
   * Proof (a) — the sign-in carrying `link_handle` resolved user U by an
   * existing provider: consume the handle (single use) and attach its identity
   * to U. An unknown, expired or used handle is link_expired.
   */
  async attachPendingLink(input: { handle: string; user_id: string; proof: LinkProof }, now: Date = new Date()): Promise<AttachOutcome> {
    const row = await this.consume(input.handle, now);
    if (row === null) return { ok: false, reason: 'link_expired' };
    return this.attachIdentity({ ...row, user_id: input.user_id, proof: input.proof });
  }

  /**
   * Proof (b), start. Returns the code to send and where, or null when nothing is
   * sent (unknown / used / expired handle, no active account for the email,
   * a resend inside 60 s, or a daily budget spent). The caller answers the same
   * 202 either way (no enumeration oracle). In the conflict case the code goes to
   * the matched account and `email` is ignored.
   */
  async startEmailProof(
    input: { handle: string; email?: string | null },
    now: Date = new Date(),
  ): Promise<{ to: string; code: string; idp: FederatedIdp } | null> {
    const row = await this.prisma.pendingIdentityLink.findUnique({ where: { handle_hash: hashLinkHandle(input.handle) } });
    if (row === null || row.consumed_at !== null || row.expires_at.getTime() <= now.getTime()) return null;
    const idp = normalizeIdp(row.idp);
    if (idp === null || idp === 'ambiguous') return null;
    let target_id: string | null = row.matched_user_id;
    if (target_id === null) {
      if (typeof input.email !== 'string' || input.email.trim().length === 0) return null;
      const byEmail = await this.prisma.user.findUnique({ where: { email: normalizeEmail(input.email) }, select: { id: true } });
      target_id = byEmail?.id ?? null;
    }
    if (target_id === null) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: target_id },
      select: { id: true, email: true, is_active: true, deactivated_at: true },
    });
    if (user === null || !user.is_active || user.deactivated_at !== null) return null;
    if (!mayResendLinkOtp({ last_sent_at: row.code_last_sent_at, sends: row.code_send_count, now })) return null;
    const perAccount = await this.prisma.pendingIdentityLink.aggregate({
      _sum: { code_send_count: true },
      where: { code_target_user_id: user.id, code_last_sent_at: { gt: new Date(now.getTime() - PENDING_LINK_RETENTION_MS) } },
    });
    if ((perAccount._sum.code_send_count ?? 0) >= LINK_OTP_MAX_SENDS_PER_DAY) return null;
    const code = generateLinkOtp();
    const code_expires_at = new Date(Math.min(now.getTime() + LINK_OTP_TTL_MS, row.expires_at.getTime()));
    // Conditional on the send count read above, so a concurrent start cannot
    // issue two codes on one count.
    const n = await this.prisma.pendingIdentityLink.updateMany({
      where: { id: row.id, consumed_at: null, code_send_count: row.code_send_count },
      data: {
        code_hash: hashLinkOtp(row.id, code),
        code_expires_at,
        code_attempts: 0,
        code_target_user_id: user.id,
        code_last_sent_at: now,
        code_send_count: { increment: 1 },
      },
    });
    if (n.count !== 1) return null;
    return { to: user.email, code, idp };
  }

  /** Proof (b), verify. On success the pending identity is attached (proof email_code). */
  async verifyEmailProof(input: { handle: string; code: unknown }, now: Date = new Date()): Promise<EmailProofVerifyOutcome> {
    const row = await this.prisma.pendingIdentityLink.findUnique({ where: { handle_hash: hashLinkHandle(input.handle) } });
    if (row === null || row.consumed_at !== null || row.expires_at.getTime() <= now.getTime()) {
      return { ok: false, reason: 'link_expired' };
    }
    const check = checkLinkOtp({ hash: row.code_hash, expires_at: row.code_expires_at, attempts: row.code_attempts }, row.id, input.code, now);
    if (check === 'exhausted') return { ok: false, reason: 'code_attempts_exceeded' };
    if (check === 'expired') return { ok: false, reason: 'code_expired' };
    if (check === 'mismatch' || check === 'none') {
      const updated = await this.prisma.pendingIdentityLink.update({
        where: { id: row.id },
        data: { code_attempts: { increment: 1 } },
        select: { code_attempts: true },
      });
      const attempts_remaining = Math.max(0, LINK_OTP_MAX_ATTEMPTS - updated.code_attempts);
      return attempts_remaining === 0
        ? { ok: false, reason: 'code_attempts_exceeded' }
        : { ok: false, reason: 'code_invalid', attempts_remaining };
    }
    const target = row.code_target_user_id;
    const consumed = await this.consume(input.handle, now);
    if (consumed === null || target === null) return { ok: false, reason: 'link_expired' };
    return this.attachIdentity({ ...consumed, user_id: target, proof: 'email_code' });
  }

  /** L-4 — the user's sign-in methods (links with a recorded provider), oldest first. */
  async listSignInMethods(user_id: string): Promise<SignInMethod[]> {
    const rows = await this.prisma.$queryRaw<{ idp: string; email_snapshot: string | null; linked_at: Date }[]>`
      SELECT p.idp, e.email_snapshot, e.created_at AS linked_at
      FROM "identity"."ExternalIdentity" e
      JOIN "identity"."ExternalIdentityIdp" p ON p.external_identity_id = e.id
      WHERE e.user_id = ${user_id}::uuid
      ORDER BY e.created_at ASC, e.id ASC`;
    const out: SignInMethod[] = [];
    for (const r of rows) {
      const idp = normalizeIdp(r.idp);
      if (idp === null || idp === 'ambiguous') continue;
      out.push({ idp, email_snapshot: r.email_snapshot, linked_at: r.linked_at });
    }
    return out;
  }

  /**
   * L-4 / L-5 — remove a sign-in method. The last remaining method (counting a
   * legacy link without a recorded provider) is never removed. Writes
   * identity.external_identity.unlinked; the security email is the caller's.
   */
  async removeSignInMethod(input: { user_id: string; idp: string }): Promise<RemoveSignInMethodOutcome> {
    const idp = normalizeIdp(input.idp);
    if (idp === null || idp === 'ambiguous') return { ok: false, reason: 'sign_in_method_not_found' };
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`identity_link:${input.user_id}`}))`;
      const user = await tx.user.findUnique({ where: { id: input.user_id }, select: { id: true, email: true } });
      if (user === null) return { ok: false, reason: 'sign_in_method_not_found' } as const;
      const links = await tx.externalIdentity.findMany({
        where: { user_id: user.id },
        select: { id: true, provider: true, provider_subject: true },
      });
      const recorded = await tx.externalIdentityIdp.findMany({
        where: { external_identity_id: { in: links.map((l) => l.id) } },
        select: { external_identity_id: true, idp: true },
      });
      const matchIds = new Set(recorded.filter((r) => r.idp === idp).map((r) => r.external_identity_id));
      const matching = links.filter((l) => matchIds.has(l.id));
      if (matching.length === 0) return { ok: false, reason: 'sign_in_method_not_found' } as const;
      if (links.length - matching.length < 1) return { ok: false, reason: 'last_sign_in_method' } as const;
      await tx.externalIdentity.deleteMany({ where: { id: { in: matching.map((l) => l.id) } } });
      return { ok: true, user_id: user.id, account_email: user.email, removed: matching } as const;
    });
    if (!result.ok) return result;
    for (const l of result.removed) {
      await this.audit.writeGlobalEvent({
        event_type: 'identity.external_identity.unlinked',
        actor_type: 'user',
        actor_id: result.user_id,
        subject_id: result.user_id,
        payload: { provider: l.provider, provider_subject: l.provider_subject, idp, reason: 'user_removed_sign_in_method' },
      });
    }
    return { ok: true, user_id: result.user_id, idp, account_email: result.account_email };
  }

  // Single use: the first caller to set consumed_at wins.
  private async consume(handle: string, now: Date): Promise<PendingIdentity | null> {
    const rows = await this.prisma.$queryRaw<{ provider: string; provider_subject: string; idp: string; email_snapshot: string | null }[]>`
      UPDATE "identity"."PendingIdentityLink" SET "consumed_at" = ${now}
      WHERE "handle_hash" = ${hashLinkHandle(handle)} AND "consumed_at" IS NULL AND "expires_at" > ${now}
      RETURNING "provider", "provider_subject", "idp", "email_snapshot"`;
    const r = rows[0];
    if (r === undefined) return null;
    const idp = normalizeIdp(r.idp);
    if (idp === null || idp === 'ambiguous') return null;
    return { provider: r.provider, provider_subject: r.provider_subject, idp, email_snapshot: r.email_snapshot };
  }
}
