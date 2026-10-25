import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type {
  CodeRedemptionOutcome,
  NativeDeviceSessionDto,
  NativePlatform,
} from './dto/native-device-session.dto.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RotationRaceError } from './refresh-token.repository.js';

// AUTH-SIGNIN-1 Amendment M-A1 §3.6/§3.8 — data access for the server-owned
// native device session and the redeemed-code ledger. Internal (not exported):
// NativeDeviceSessionService is the public surface, the same repo/service split
// as RefreshToken. Refresh tokens stay in auth_storage."RefreshToken" (hashed);
// the device session links to its family by id, so no column is added to an
// existing table.

interface RawNativeDeviceSessionRow {
  id: string;
  user_id: string;
  tenant_id: string;
  consumer_type: string;
  client_id: string;
  installation_id: string;
  platform: string;
  app_version: string;
  refresh_family_root_id: string;
  current_refresh_token_id: string;
  created_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
}

interface LockedRefreshRow {
  id: string;
  user_id: string;
  tenant_id: string;
  consumer_type: string;
  revoked_at: Date | null;
  replaced_by_id: string | null;
}

function toDto(row: RawNativeDeviceSessionRow): NativeDeviceSessionDto {
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    consumer_type: row.consumer_type,
    client_id: row.client_id,
    installation_id: row.installation_id,
    // CHECK-constrained column (ios | android); the cast is safe.
    platform: row.platform as NativePlatform,
    app_version: row.app_version,
    refresh_family_root_id: row.refresh_family_root_id,
    current_refresh_token_id: row.current_refresh_token_id,
    created_at: row.created_at.toISOString(),
    last_seen_at: row.last_seen_at.toISOString(),
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    revoke_reason: row.revoke_reason,
  };
}

@Injectable()
export class NativeDeviceSessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // The single-use ledger. Expired rows are pruned first; the insert is
  // ON CONFLICT DO NOTHING (createMany skipDuplicates), so of two concurrent
  // redemptions of one code exactly one wins. A conflict on the nonce alone is
  // reported separately (an ID-token nonce is single-use too).
  async redeemCode(args: {
    code_hash: string;
    nonce_hash: string;
    client_id: string;
    expires_at: Date;
  }): Promise<CodeRedemptionOutcome> {
    await this.prisma.nativeRedeemedCode.deleteMany({ where: { expires_at: { lt: new Date() } } });
    const inserted = await this.prisma.nativeRedeemedCode.createMany({
      data: [
        {
          code_hash: args.code_hash,
          nonce_hash: args.nonce_hash,
          client_id: args.client_id,
          expires_at: args.expires_at,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 1) return 'redeemed';
    const byCode = await this.prisma.nativeRedeemedCode.findUnique({ where: { code_hash: args.code_hash } });
    return byCode !== null ? 'code_already_redeemed' : 'nonce_replayed';
  }

  // One transaction: the family's first refresh token and the device session
  // that owns it.
  async createSession(args: {
    user_id: string;
    tenant_id: string;
    consumer_type: string;
    refresh_consumer_type: string;
    client_id: string;
    installation_id: string;
    platform: NativePlatform;
    app_version: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<{ session: NativeDeviceSessionDto; refresh_token_id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const tokenId = uuidv7();
      await tx.refreshToken.create({
        data: {
          id: tokenId,
          user_id: args.user_id,
          tenant_id: args.tenant_id,
          consumer_type: args.refresh_consumer_type,
          token_hash: args.token_hash,
          expires_at: args.expires_at,
        },
      });
      const row = (await tx.nativeDeviceSession.create({
        data: {
          id: uuidv7(),
          user_id: args.user_id,
          tenant_id: args.tenant_id,
          consumer_type: args.consumer_type,
          client_id: args.client_id,
          installation_id: args.installation_id,
          platform: args.platform,
          app_version: args.app_version,
          refresh_family_root_id: tokenId,
          current_refresh_token_id: tokenId,
        },
      })) as RawNativeDeviceSessionRow;
      return { session: toDto(row), refresh_token_id: tokenId };
    });
  }

  async findById(id: string): Promise<NativeDeviceSessionDto | null> {
    const row = (await this.prisma.nativeDeviceSession.findUnique({ where: { id } })) as RawNativeDeviceSessionRow | null;
    return row === null ? null : toDto(row);
  }

  // The live session whose CURRENT token is `refresh_token_id` (null when the
  // token is a rotated-away member, or the session is revoked).
  async findActiveByCurrentToken(refresh_token_id: string): Promise<NativeDeviceSessionDto | null> {
    const row = (await this.prisma.nativeDeviceSession.findFirst({
      where: { current_refresh_token_id: refresh_token_id, revoked_at: null },
    })) as RawNativeDeviceSessionRow | null;
    return row === null ? null : toDto(row);
  }

  // Rotation bound to the device session, atomically: lock the old token, insert
  // the successor, retire the old (guarded on revoked_at/replaced_by_id IS NULL,
  // the RefreshTokenRepository.rotate rule), and move the session's current
  // pointer (guarded on the session still being live and still pointing at the
  // old token). Any guard miss rolls everything back with RotationRaceError.
  async rotateForSession(args: {
    session_id: string;
    old_token_id: string;
    new_token_hash: string;
    new_expires_at: Date;
  }): Promise<{ new_token_id: string; session: NativeDeviceSessionDto }> {
    return this.prisma.$transaction(async (tx) => {
      const locked = (await tx.$queryRawUnsafe(
        `SELECT id, user_id, tenant_id, consumer_type, revoked_at, replaced_by_id
         FROM auth_storage."RefreshToken"
         WHERE id = $1::uuid
         FOR UPDATE`,
        args.old_token_id,
      )) as LockedRefreshRow[];
      const old = locked[0];
      if (old === undefined) throw new RotationRaceError();
      const newId = uuidv7();
      await tx.refreshToken.create({
        data: {
          id: newId,
          user_id: old.user_id,
          tenant_id: old.tenant_id,
          consumer_type: old.consumer_type,
          token_hash: args.new_token_hash,
          expires_at: args.new_expires_at,
        },
      });
      const retired = await tx.refreshToken.updateMany({
        where: { id: args.old_token_id, revoked_at: null, replaced_by_id: null },
        data: { revoked_at: new Date(), replaced_by_id: newId },
      });
      if (retired.count !== 1) throw new RotationRaceError();
      const moved = await tx.nativeDeviceSession.updateMany({
        where: { id: args.session_id, revoked_at: null, current_refresh_token_id: args.old_token_id },
        data: { current_refresh_token_id: newId, last_seen_at: new Date() },
      });
      if (moved.count !== 1) throw new RotationRaceError();
      const row = (await tx.nativeDeviceSession.findUnique({ where: { id: args.session_id } })) as RawNativeDeviceSessionRow;
      return { new_token_id: newId, session: toDto(row) };
    });
  }

  // LIVE = the session is not revoked AND its current refresh token is neither
  // revoked nor expired. The second clause covers a user-wide token revocation
  // made outside the native path (the browser R.2 reuse cascade revokes every
  // refresh token of the user), so such a session is never listed or honoured.
  private async liveOnly(rows: RawNativeDeviceSessionRow[]): Promise<RawNativeDeviceSessionRow[]> {
    const open = rows.filter((r) => r.revoked_at === null);
    if (open.length === 0) return [];
    const live = await this.prisma.refreshToken.findMany({
      where: {
        id: { in: open.map((r) => r.current_refresh_token_id) },
        revoked_at: null,
        expires_at: { gt: new Date() },
      },
      select: { id: true },
    });
    const ids = new Set(live.map((t) => t.id));
    return open.filter((r) => ids.has(r.current_refresh_token_id));
  }

  async findLiveById(id: string): Promise<NativeDeviceSessionDto | null> {
    const row = (await this.prisma.nativeDeviceSession.findUnique({ where: { id } })) as RawNativeDeviceSessionRow | null;
    if (row === null) return null;
    const [live] = await this.liveOnly([row]);
    return live === undefined ? null : toDto(live);
  }

  async listActiveForUser(args: { user_id: string; tenant_id: string }): Promise<NativeDeviceSessionDto[]> {
    const rows = (await this.prisma.nativeDeviceSession.findMany({
      where: { user_id: args.user_id, tenant_id: args.tenant_id, revoked_at: null },
      orderBy: { created_at: 'desc' },
    })) as RawNativeDeviceSessionRow[];
    return (await this.liveOnly(rows)).map(toDto);
  }

  // Revoke one session AND its refresh-token family. Rotation retires every
  // earlier member as it goes, so the only unrevoked member is the current
  // token; it is revoked in the same transaction. Returns false when the
  // session was not live (already revoked / absent).
  async revokeSession(args: { id: string; reason: string }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.nativeDeviceSession.updateMany({
        where: { id: args.id, revoked_at: null },
        data: { revoked_at: new Date(), revoke_reason: args.reason },
      });
      if (updated.count !== 1) return false;
      const row = (await tx.nativeDeviceSession.findUnique({ where: { id: args.id } })) as RawNativeDeviceSessionRow;
      await tx.refreshToken.updateMany({
        where: { id: row.current_refresh_token_id, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      return true;
    });
  }

  async revokeAllForUser(args: { user_id: string; reason: string }): Promise<{ revoked_count: number }> {
    const result = await this.prisma.nativeDeviceSession.updateMany({
      where: { user_id: args.user_id, revoked_at: null },
      data: { revoked_at: new Date(), revoke_reason: args.reason },
    });
    return { revoked_count: result.count };
  }
}
