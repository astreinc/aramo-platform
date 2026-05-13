import { Injectable } from '@nestjs/common';

import type { RefreshTokenDto } from './dto/refresh-token.dto.js';
import { RefreshTokenRepository } from './refresh-token.repository.js';

// PR-8.0a-Reground §7. Public service surface for the auth-storage module.
// Exported via AuthStorageModule. Repository remains internal.
//
// `detectReuse` is a pure helper (no DB call): given a token DTO and the
// configured grace_seconds, returns whether the token represents a reuse
// attempt past the grace window. Caller (RefreshOrchestratorService) reads
// the token first via findByHash, then calls detectReuse.
@Injectable()
export class RefreshTokenService {
  constructor(private readonly refreshRepo: RefreshTokenRepository) {}

  async create(args: {
    user_id: string;
    tenant_id: string;
    consumer_type: string;
    token_hash: string;
    expires_at: Date;
  }): Promise<RefreshTokenDto> {
    return this.refreshRepo.create(args);
  }

  async findByHash(args: { token_hash: string }): Promise<RefreshTokenDto | null> {
    return this.refreshRepo.findByHash(args);
  }

  async rotate(args: {
    old_id: string;
    new_token_hash: string;
    new_expires_at: Date;
  }): Promise<{ new_token: RefreshTokenDto; old_token: RefreshTokenDto }> {
    return this.refreshRepo.rotate(args);
  }

  async revoke(args: { id: string }): Promise<RefreshTokenDto> {
    return this.refreshRepo.revoke(args);
  }

  async revokeAllForUser(args: { user_id: string }): Promise<{ revoked_count: number }> {
    return this.refreshRepo.revokeAllForUser(args);
  }

  // Per directive §7: returns true iff `replaced_by_id` is set AND the token
  // was rotated more than `grace_seconds` ago (`now - revoked_at > grace`).
  // Tokens still within the grace window after rotation are NOT reuses;
  // they accommodate clients that retried mid-rotation. revoked_at must be
  // set when replaced_by_id is set (rotate() sets both atomically).
  async detectReuse(args: {
    token: RefreshTokenDto;
    grace_seconds: number;
  }): Promise<boolean> {
    const { token, grace_seconds } = args;
    if (token.replaced_by_id === null) return false;
    if (token.revoked_at === null) return false;
    const revokedMs = Date.parse(token.revoked_at);
    const ageSeconds = (Date.now() - revokedMs) / 1000;
    return ageSeconds > grace_seconds;
  }
}
