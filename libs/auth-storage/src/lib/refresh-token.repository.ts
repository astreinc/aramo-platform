import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import type { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Marker error: signals a rotation race rolled the transaction back per
// directive §7 rotate behavior Step 4. Caller (RefreshOrchestratorService)
// distinguishes this from other failures and returns 401 REFRESH_TOKEN_INVALID.
export class RotationRaceError extends Error {
  constructor() {
    super('refresh-token-rotation-race');
    this.name = 'RotationRaceError';
  }
}

interface RawRefreshTokenRow {
  id: string;
  user_id: string;
  tenant_id: string;
  consumer_type: string;
  token_hash: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  replaced_by_id: string | null;
}

function toDto(row: RawRefreshTokenRow): RefreshTokenDto {
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id,
    consumer_type: row.consumer_type,
    token_hash: row.token_hash,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    revoked_at: row.revoked_at === null ? null : row.revoked_at.toISOString(),
    replaced_by_id: row.replaced_by_id,
  };
}

@Injectable()
export class RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(args: {
    user_id: string;
    tenant_id: string;
    consumer_type: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<RefreshTokenDto> {
    const row = (await this.prisma.refreshToken.create({
      data: {
        id: uuidv7(),
        user_id: args.user_id,
        tenant_id: args.tenant_id,
        consumer_type: args.consumer_type,
        token_hash: args.token_hash,
        expires_at: args.expires_at,
      },
    })) as RawRefreshTokenRow;
    return toDto(row);
  }

  async findByHash(args: { token_hash: string }): Promise<RefreshTokenDto | null> {
    const row = (await this.prisma.refreshToken.findUnique({
      where: { token_hash: args.token_hash },
    })) as RawRefreshTokenRow | null;
    return row === null ? null : toDto(row);
  }

  // Per directive §7 rotate behavior. Single Prisma transaction with
  // FOR UPDATE row lock on the old row + conditional update guarded by
  // (revoked_at IS NULL AND replaced_by_id IS NULL). On race, throws
  // RotationRaceError to roll the transaction back; caller treats as 401.
  async rotate(args: {
    old_id: string;
    new_token_hash: string;
    new_expires_at: Date;
  }): Promise<{ new_token: RefreshTokenDto; old_token: RefreshTokenDto }> {
    return this.prisma.$transaction(async (tx) => {
      // Step 1 — explicit FOR UPDATE lock. Prisma's findUnique does NOT lock,
      // so we go via $queryRaw. Two parallel /refresh transactions on the
      // same row will serialize on this lock.
      const locked = (await tx.$queryRawUnsafe(
        `SELECT id, user_id, tenant_id, consumer_type, token_hash,
                created_at, updated_at, expires_at, revoked_at, replaced_by_id
         FROM auth_storage."RefreshToken"
         WHERE id = $1::uuid
         FOR UPDATE`,
        args.old_id,
      )) as RawRefreshTokenRow[];
      if (locked.length === 0) {
        throw new Error(`refresh-token-not-found: ${args.old_id}`);
      }
      const old = locked[0]!;

      // Step 2-3 — insert the new row with derived bindings.
      const newId = uuidv7();
      const newRow = (await tx.refreshToken.create({
        data: {
          id: newId,
          user_id: old.user_id,
          tenant_id: old.tenant_id,
          consumer_type: old.consumer_type,
          token_hash: args.new_token_hash,
          expires_at: args.new_expires_at,
        },
      })) as RawRefreshTokenRow;

      // Step 4 — conditional update on old row. updateMany returns affected
      // count; 0 means the (revoked_at IS NULL AND replaced_by_id IS NULL)
      // guard failed because another transaction already rotated this token.
      // Throwing rolls the entire transaction back including the new row.
      const updated = await tx.refreshToken.updateMany({
        where: {
          id: args.old_id,
          revoked_at: null,
          replaced_by_id: null,
        },
        data: {
          revoked_at: new Date(),
          replaced_by_id: newId,
        },
      });
      if (updated.count !== 1) {
        throw new RotationRaceError();
      }

      // Step 5 — re-read old to capture server-set revoked_at/replaced_by_id.
      const updatedOld = (await tx.refreshToken.findUnique({
        where: { id: args.old_id },
      })) as RawRefreshTokenRow;
      return { new_token: toDto(newRow), old_token: toDto(updatedOld) };
    });
  }

  async revoke(args: { id: string }): Promise<RefreshTokenDto> {
    const row = (await this.prisma.refreshToken.update({
      where: { id: args.id },
      data: { revoked_at: new Date() },
    })) as RawRefreshTokenRow;
    return toDto(row);
  }

  async revokeAllForUser(args: { user_id: string }): Promise<{ revoked_count: number }> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { user_id: args.user_id, revoked_at: null },
      data: { revoked_at: new Date() },
    });
    return { revoked_count: result.count };
  }
}
