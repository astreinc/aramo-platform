import { Injectable } from '@nestjs/common';

import type {
  CodeRedemptionOutcome,
  NativeDeviceSessionDto,
  NativePlatform,
} from './dto/native-device-session.dto.js';
import { NativeDeviceSessionRepository } from './native-device-session.repository.js';

// AUTH-SIGNIN-1 Amendment M-A1 §3.6/§3.8 — public service surface for the
// server-owned native device session + the redeemed-code ledger. Exported via
// AuthStorageModule; the repository stays internal.
@Injectable()
export class NativeDeviceSessionService {
  constructor(private readonly repo: NativeDeviceSessionRepository) {}

  async redeemCode(args: {
    code_hash: string;
    nonce_hash: string;
    client_id: string;
    expires_at: Date;
  }): Promise<CodeRedemptionOutcome> {
    return this.repo.redeemCode(args);
  }

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
    return this.repo.createSession(args);
  }

  async findById(id: string): Promise<NativeDeviceSessionDto | null> {
    return this.repo.findById(id);
  }

  async findActiveByCurrentToken(refresh_token_id: string): Promise<NativeDeviceSessionDto | null> {
    return this.repo.findActiveByCurrentToken(refresh_token_id);
  }

  async rotateForSession(args: {
    session_id: string;
    old_token_id: string;
    new_token_hash: string;
    new_expires_at: Date;
  }): Promise<{ new_token_id: string; session: NativeDeviceSessionDto }> {
    return this.repo.rotateForSession(args);
  }

  async listActiveForUser(args: { user_id: string; tenant_id: string }): Promise<NativeDeviceSessionDto[]> {
    return this.repo.listActiveForUser(args);
  }

  // Owner-scoped read: the session only when it belongs to (user, tenant) and is
  // live. Anything else is null, so callers answer 404 without revealing whether
  // the id exists.
  async findOwnedActive(args: { id: string; user_id: string; tenant_id: string }): Promise<NativeDeviceSessionDto | null> {
    const s = await this.repo.findLiveById(args.id);
    if (s === null) return null;
    if (s.user_id !== args.user_id || s.tenant_id !== args.tenant_id) return null;
    return s;
  }

  // True when the device session is LIVE: not revoked, and its current refresh
  // token neither revoked nor expired (the authority for a `dsid`).
  async isActive(id: string): Promise<boolean> {
    return (await this.repo.findLiveById(id)) !== null;
  }

  async revokeSession(args: { id: string; reason: string }): Promise<boolean> {
    return this.repo.revokeSession(args);
  }

  async revokeAllForUser(args: { user_id: string; reason: string }): Promise<{ revoked_count: number }> {
    return this.repo.revokeAllForUser(args);
  }
}
