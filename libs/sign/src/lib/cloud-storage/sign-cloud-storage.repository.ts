import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

// SIGN-FREE-PARITY-1 S6 (FP-R7) — connected cloud storage accounts and pending OAuth connects.
// Owned by exactly one (tenant, user): every read, write and delete is filtered by BOTH (a
// connection never crosses users, even inside one tenant). Token columns hold ciphertext
// only: sign-service encrypts before writing and decrypts after reading
// (SIGN_CLOUD_TOKEN_KEY); this repository never sees a plaintext token.

export interface CloudOwner {
  readonly tenant_id: string;
  readonly user_id: string;
}

export interface CloudConnectionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  provider: string;
  account_label: string | null;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  access_token_expires_at: Date | null;
  scopes: string;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date | null;
}

export interface CloudOAuthStateRow {
  id: string;
  tenant_id: string;
  user_id: string;
  provider: string;
  state_sha256: string;
  code_verifier_ciphertext: string;
  client: string;
  return_path: string | null;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface CloudTokenWrite {
  access_token_ciphertext: string;
  /** Undefined keeps the stored refresh token (the provider sent none). */
  refresh_token_ciphertext?: string | null;
  access_token_expires_at: Date | null;
}

@Injectable()
export class SignCloudStorageRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── pending connects ──

  /** Record a pending connect; the owner's finished or expired ones are cleared first. */
  async createState(row: Omit<CloudOAuthStateRow, 'id' | 'created_at' | 'consumed_at'>, now: Date): Promise<void> {
    await this.prisma.signCloudOAuthState.deleteMany({
      where: { tenant_id: row.tenant_id, user_id: row.user_id, OR: [{ consumed_at: { not: null } }, { expires_at: { lte: now } }] },
    });
    await this.prisma.signCloudOAuthState.create({ data: { id: randomUUID(), ...row, created_at: now } });
  }

  /**
   * Single use: marks the state consumed in one conditional update (unconsumed, unexpired,
   * this provider) and returns it; null when it is unknown, used, expired or for another
   * provider. Two concurrent callbacks cannot both succeed.
   */
  async consumeState(state_sha256: string, provider: string, now: Date): Promise<CloudOAuthStateRow | null> {
    const r = await this.prisma.signCloudOAuthState.updateMany({
      where: { state_sha256, provider, consumed_at: null, expires_at: { gt: now } },
      data: { consumed_at: now },
    });
    if (r.count !== 1) return null;
    return this.prisma.signCloudOAuthState.findUnique({ where: { state_sha256 } });
  }

  // ── connections ──

  async listConnections(owner: CloudOwner): Promise<CloudConnectionRow[]> {
    return this.prisma.signCloudConnection.findMany({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id }, orderBy: { created_at: 'asc' } });
  }

  async getConnection(owner: CloudOwner, provider: string): Promise<CloudConnectionRow | null> {
    return this.prisma.signCloudConnection.findFirst({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id, provider } });
  }

  /** Connect (or reconnect, replacing the tokens) one provider for the owner. */
  async upsertConnection(
    owner: CloudOwner,
    provider: string,
    data: { account_label: string | null; access_token_ciphertext: string; refresh_token_ciphertext: string | null; access_token_expires_at: Date | null; scopes: string },
    now: Date,
  ): Promise<CloudConnectionRow> {
    return this.prisma.signCloudConnection.upsert({
      where: { tenant_id_user_id_provider: { tenant_id: owner.tenant_id, user_id: owner.user_id, provider } },
      create: { id: randomUUID(), tenant_id: owner.tenant_id, user_id: owner.user_id, provider, ...data, created_at: now, updated_at: now },
      update: { ...data, updated_at: now },
    });
  }

  async updateTokens(owner: CloudOwner, provider: string, tokens: CloudTokenWrite, now: Date): Promise<void> {
    await this.prisma.signCloudConnection.updateMany({
      where: { tenant_id: owner.tenant_id, user_id: owner.user_id, provider },
      data: {
        access_token_ciphertext: tokens.access_token_ciphertext,
        access_token_expires_at: tokens.access_token_expires_at,
        ...(tokens.refresh_token_ciphertext !== undefined ? { refresh_token_ciphertext: tokens.refresh_token_ciphertext } : {}),
        updated_at: now,
      },
    });
  }

  async touch(owner: CloudOwner, provider: string, now: Date): Promise<void> {
    await this.prisma.signCloudConnection.updateMany({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id, provider }, data: { last_used_at: now } });
  }

  /** Delete one connection (disconnect). Returns how many rows went (0 or 1). */
  async deleteConnection(owner: CloudOwner, provider: string): Promise<number> {
    const r = await this.prisma.signCloudConnection.deleteMany({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id, provider } });
    await this.prisma.signCloudOAuthState.deleteMany({ where: { tenant_id: owner.tenant_id, user_id: owner.user_id, provider } });
    return r.count;
  }
}
