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
          data: { last_login_at: input.now },
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
          data: { last_login_at: input.now },
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
