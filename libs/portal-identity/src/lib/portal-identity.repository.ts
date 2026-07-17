import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the portal_identity store (Portal P1). The Prisma boundary
// for PortalUser (the passwordless portal identity) + PortalLoginToken (the
// single-use magic-link tokens). UUID v7 PKs generated app-side (Postgres 17 has
// no native uuidv7(); the workspace precedent). The token mint/rotate/consume
// methods mirror the TR-3 VerificationRequest repository conventions verbatim.

export interface PortalUserRow {
  id: string;
  email_normalized: string;
  cluster_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}

export interface PortalLoginTokenRow {
  id: string;
  email_normalized: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

// Portal P4 P4a — a durable notice-delivery record (portal_user-keyed).
export interface NoticeDeliveryRow {
  id: string;
  portal_user_id: string;
  notice_version: string;
  channel: string;
  delivered_at: Date;
  created_at: Date;
}

@Injectable()
export class PortalIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // PortalUser
  // ===========================================================================

  /** Look a portal up by normalized email (the login key). Null if unknown. */
  async findPortalByEmail(
    emailNormalized: string,
  ): Promise<PortalUserRow | null> {
    const row = await this.prisma.portalUser.findUnique({
      where: { email_normalized: emailNormalized },
    });
    return row === null ? null : toPortalRow(row);
  }

  /**
   * Look a portal up by id — the JWT `sub` on a portal session IS the PortalUser
   * id (Portal P1 ruling 4). The OPEN-4 chain (PR-2) starts here: `sub` →
   * PortalUser → `cluster_id`. Null if unknown (a valid empty state).
   */
  async findPortalById(id: string): Promise<PortalUserRow | null> {
    const row = await this.prisma.portalUser.findUnique({ where: { id } });
    return row === null ? null : toPortalRow(row);
  }

  /**
   * Find-or-mint the PortalUser for a successful login (Portal P1 ruling 3 —
   * lazy mint at first token consumption). If the user exists, stamp
   * `last_login_at`; else mint with `cluster_id` from the eligibility lookup +
   * `last_login_at`. Race-safe: a concurrent mint (unique on email_normalized)
   * loses the create and re-reads the winner, then stamps the login.
   */
  async findOrCreatePortalOnLogin(input: {
    email_normalized: string;
    cluster_id: string | null;
    now: Date;
  }): Promise<PortalUserRow> {
    const existing = await this.findPortalByEmail(input.email_normalized);
    if (existing !== null) {
      return toPortalRow(
        await this.prisma.portalUser.update({
          where: { id: existing.id },
          data: {
            last_login_at: input.now,
            // TR-2b B2b (Directive ruling 2) — login-time cluster re-link. A
            // MONOTONIC fill-once: set cluster_id ONLY when it is currently NULL
            // and the eligibility lookup now carries a hit. Never overwrite an
            // existing non-null cluster, never clear it (split-bias). This is how
            // a portal user whose orphaned cluster was purged (B2a/B2b) re-links
            // to the fresh cluster at their next login, no manual step.
            ...(existing.cluster_id === null && input.cluster_id !== null
              ? { cluster_id: input.cluster_id }
              : {}),
          },
        }),
      );
    }
    try {
      return toPortalRow(
        await this.prisma.portalUser.create({
          data: {
            id: uuidv7(),
            email_normalized: input.email_normalized,
            cluster_id: input.cluster_id,
            last_login_at: input.now,
          },
        }),
      );
    } catch (err) {
      // Lost the mint race (unique-violation on email_normalized) → the winner
      // now exists; re-read and stamp the login. Any other error propagates.
      const afterRace = await this.findPortalByEmail(input.email_normalized);
      if (afterRace === null) throw err;
      return toPortalRow(
        await this.prisma.portalUser.update({
          where: { id: afterRace.id },
          data: {
            last_login_at: input.now,
            // Same monotonic fill-once as the happy path (the lost-race winner
            // may equally have a NULL cluster to re-link).
            ...(afterRace.cluster_id === null && input.cluster_id !== null
              ? { cluster_id: input.cluster_id }
              : {}),
          },
        }),
      );
    }
  }

  // ===========================================================================
  // PortalLoginToken (TR-3 VerificationRequest conventions verbatim)
  // ===========================================================================

  /** Mint a new login token row (caller supplies the sha256.base64url hash). */
  async createLoginToken(input: {
    email_normalized: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<PortalLoginTokenRow> {
    return toTokenRow(
      await this.prisma.portalLoginToken.create({
        data: {
          id: uuidv7(),
          email_normalized: input.email_normalized,
          token_hash: input.token_hash,
          expires_at: input.expires_at,
        },
      }),
    );
  }

  /**
   * The newest OPEN (unconsumed, unexpired) token for an email — the
   * idempotency-read that drives rotate-vs-mint on resend (TR-3 pattern). An
   * expired-but-unconsumed row is NOT open.
   */
  async findOpenLoginToken(
    emailNormalized: string,
    now: Date,
  ): Promise<PortalLoginTokenRow | null> {
    const row = await this.prisma.portalLoginToken.findFirst({
      where: {
        email_normalized: emailNormalized,
        consumed_at: null,
        expires_at: { gt: now },
      },
      orderBy: { created_at: 'desc' },
    });
    return row === null ? null : toTokenRow(row);
  }

  /**
   * Rotate a token in place (resend): a fresh hash + expiry on the same row. The
   * prior raw dies because its hash no longer matches (TR-3 rotate-in-place).
   */
  async rotateLoginToken(input: {
    id: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<PortalLoginTokenRow> {
    return toTokenRow(
      await this.prisma.portalLoginToken.update({
        where: { id: input.id },
        data: { token_hash: input.token_hash, expires_at: input.expires_at },
      }),
    );
  }

  /**
   * Atomic single-use consume (the replay guard, TR-3 verbatim minus the status
   * column): a guarded `updateMany` flips `consumed_at` iff the row is unconsumed
   * and unexpired — exactly one concurrent consumer wins (the Postgres row lock);
   * the losers match zero rows. Returns the consumed row (carrying the
   * email_normalized the login mints against) or null for every invalid state
   * (unknown / expired / already-consumed — indistinguishable, oracle-resistant).
   */
  async consumeLoginToken(
    tokenHash: string,
    now: Date,
  ): Promise<PortalLoginTokenRow | null> {
    const claimed = await this.prisma.portalLoginToken.updateMany({
      where: { token_hash: tokenHash, consumed_at: null, expires_at: { gt: now } },
      data: { consumed_at: now },
    });
    if (claimed.count === 0) return null;
    const row = await this.prisma.portalLoginToken.findUnique({
      where: { token_hash: tokenHash },
    });
    return row === null ? null : toTokenRow(row);
  }

  // ===========================================================================
  // NoticeDelivery (Portal P4 P4a)
  // ===========================================================================

  /**
   * The portal user(s) resolving to a cluster — the dormant-notice delivery
   * target. `cluster_id` is nullable + non-unique on PortalUser, so a dormant
   * cluster may map to zero portals (nobody ever signed in → nothing to deliver)
   * or, in principle, more than one. Ordered by created_at for a deterministic
   * primary target. The join the D-4 chain walks: DormantLink.cluster_id →
   * PortalUser.cluster_id → PortalUser.id.
   */
  async findPortalsByClusterId(clusterId: string): Promise<PortalUserRow[]> {
    const rows = await this.prisma.portalUser.findMany({
      where: { cluster_id: clusterId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map(toPortalRow);
  }

  /**
   * Append a durable notice-delivery record. This is the portal_identity "durable
   * record" whose existence licenses the DormantLink → NOTICED transition
   * (app-layer provenance for the D14 invariant). Append-only.
   */
  async insertNoticeDelivery(input: {
    portal_user_id: string;
    notice_version: string;
    channel: string;
    delivered_at: Date;
  }): Promise<NoticeDeliveryRow> {
    const row = await this.prisma.noticeDelivery.create({
      data: {
        id: uuidv7(),
        portal_user_id: input.portal_user_id,
        notice_version: input.notice_version,
        channel: input.channel,
        delivered_at: input.delivered_at,
      },
    });
    return toNoticeDeliveryRow(row);
  }

  /** All notice-delivery records for a portal user (audit / test read). */
  async findNoticeDeliveriesByPortal(
    portalUserId: string,
  ): Promise<NoticeDeliveryRow[]> {
    const rows = await this.prisma.noticeDelivery.findMany({
      where: { portal_user_id: portalUserId },
      orderBy: { created_at: 'asc' },
    });
    return rows.map(toNoticeDeliveryRow);
  }

  // ===========================================================================
  // RTBF (Portal P4 P4b) — erase ALL portal_identity residue for one identity
  // ===========================================================================

  /**
   * Portal P4 P4b (D-2) — delete every portal_identity row for one portal user:
   * its NoticeDelivery records (keyed on portal_user_id), its PortalLoginToken
   * rows (keyed on email_normalized — tokens have no PortalUser FK), and the
   * PortalUser itself. Atomic (single $transaction). This runs AFTER purgeCluster
   * (which only NULLs PortalUser.cluster_id, never deletes the row) — it is the
   * platform-rail RTBF's portal_identity leg. Idempotent at the caller level (a
   * re-run over an already-erased identity deletes zero rows). Tenant-rail records
   * are NOT touched (D-2 — each tenant is a separate controller).
   */
  async eraseByPortalUser(input: {
    portalUserId: string;
    emailNormalized: string;
  }): Promise<{
    notice_deliveries_deleted: number;
    login_tokens_deleted: number;
    portal_user_deleted: number;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const nd = await tx.noticeDelivery.deleteMany({
        where: { portal_user_id: input.portalUserId },
      });
      const lt = await tx.portalLoginToken.deleteMany({
        where: { email_normalized: input.emailNormalized },
      });
      const pu = await tx.portalUser.deleteMany({
        where: { id: input.portalUserId },
      });
      return {
        notice_deliveries_deleted: nd.count,
        login_tokens_deleted: lt.count,
        portal_user_deleted: pu.count,
      };
    });
  }
}

function toPortalRow(row: {
  id: string;
  email_normalized: string;
  cluster_id: string | null;
  created_at: Date;
  updated_at: Date;
  last_login_at: Date | null;
}): PortalUserRow {
  return {
    id: row.id,
    email_normalized: row.email_normalized,
    cluster_id: row.cluster_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_login_at: row.last_login_at,
  };
}

function toTokenRow(row: {
  id: string;
  email_normalized: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}): PortalLoginTokenRow {
  return {
    id: row.id,
    email_normalized: row.email_normalized,
    token_hash: row.token_hash,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    created_at: row.created_at,
  };
}

function toNoticeDeliveryRow(row: {
  id: string;
  portal_user_id: string;
  notice_version: string;
  channel: string;
  delivered_at: Date;
  created_at: Date;
}): NoticeDeliveryRow {
  return {
    id: row.id,
    portal_user_id: row.portal_user_id,
    notice_version: row.notice_version,
    channel: row.channel,
    delivered_at: row.delivered_at,
    created_at: row.created_at,
  };
}
