import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { IdentityAuditService, RoleService } from '@aramo/identity';
import { RefreshTokenService, RotationRaceError } from '@aramo/auth-storage';

import { JwtIssuerService } from './jwt-issuer.service.js';

// PR-8.0a-Reground §8.3 refresh orchestrator. Returns a discriminated
// result; the controller maps to HTTP and cookie writes (clearing both
// cookies on every 401 path). Best-effort audit emission.

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_BYTES = 32;
const DEFAULT_GRACE_SECONDS = 30;

export interface RefreshInput {
  consumer: 'recruiter' | 'portal' | 'ingestion';
  refreshCookie: string | undefined;
}

export type RefreshResult =
  | {
      kind: 'success';
      accessJwt: string;
      refreshTokenPlaintext: string;
    }
  | { kind: 'token_invalid'; reason: string }
  | { kind: 'internal_error'; reason: string };

@Injectable()
export class RefreshOrchestratorService {
  private readonly logger = new Logger(RefreshOrchestratorService.name);

  constructor(
    private readonly refreshTokens: RefreshTokenService,
    private readonly role: RoleService,
    private readonly jwtIssuer: JwtIssuerService,
    private readonly audit: IdentityAuditService,
  ) {}

  async handleRefresh(input: RefreshInput): Promise<RefreshResult> {
    if (input.refreshCookie === undefined || input.refreshCookie.length === 0) {
      return { kind: 'token_invalid', reason: 'cookie_missing' };
    }
    const tokenHash = sha256Base64Url(input.refreshCookie);
    const found = await this.refreshTokens.findByHash({ token_hash: tokenHash });
    if (found === null) {
      return { kind: 'token_invalid', reason: 'not_found' };
    }
    if (Date.parse(found.expires_at) <= Date.now()) {
      return { kind: 'token_invalid', reason: 'expired' };
    }
    if (found.revoked_at !== null && found.replaced_by_id === null) {
      return { kind: 'token_invalid', reason: 'explicitly_revoked' };
    }
    if (found.consumer_type !== input.consumer) {
      return { kind: 'token_invalid', reason: 'consumer_mismatch' };
    }

    const graceSeconds = readGraceSeconds();
    const isReuse = await this.refreshTokens.detectReuse({
      token: found,
      grace_seconds: graceSeconds,
    });
    if (isReuse) {
      // R.2 cascade: revoke ALL of user's tokens, emit ONE audit event.
      try {
        await this.refreshTokens.revokeAllForUser({ user_id: found.user_id });
      } catch (err) {
        this.logger.warn(`R.2 cascade revoke failed: ${(err as Error).message}`);
      }
      await this.audit.writeEvent({
        event_type: 'identity.session.reuse_detected',
        actor_type: 'user',
        actor_id: found.user_id,
        tenant_id: found.tenant_id,
        subject_id: found.user_id,
        payload: { presented_token_id: found.id },
      });
      return { kind: 'token_invalid', reason: 'reuse_detected' };
    }

    // Normal refresh: re-derive scopes, generate new plaintext, rotate.
    const scopes = await this.role.getScopesByUserAndTenant({
      user_id: found.user_id,
      tenant_id: found.tenant_id,
    });

    const newPlaintext = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const newHash = sha256Base64Url(newPlaintext);
    const newExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    let rotated;
    try {
      rotated = await this.refreshTokens.rotate({
        old_id: found.id,
        new_token_hash: newHash,
        new_expires_at: newExpires,
      });
    } catch (err) {
      if (err instanceof RotationRaceError) {
        return { kind: 'token_invalid', reason: 'rotation_race' };
      }
      this.logger.warn(`refresh rotate failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'refresh_rotate_failed' };
    }

    let accessJwt: string;
    try {
      accessJwt = await this.jwtIssuer.sign({
        sub: found.user_id,
        consumer_type: input.consumer,
        tenant_id: found.tenant_id,
        scopes,
      });
    } catch (err) {
      this.logger.warn(`jwt sign on refresh failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'jwt_sign_failed' };
    }

    await this.audit.writeEvent({
      event_type: 'identity.session.refreshed',
      actor_type: 'user',
      actor_id: found.user_id,
      tenant_id: found.tenant_id,
      subject_id: found.user_id,
      payload: {
        old_refresh_token_id: found.id,
        new_refresh_token_id: rotated.new_token.id,
      },
    });

    return {
      kind: 'success',
      accessJwt,
      refreshTokenPlaintext: newPlaintext,
    };
  }
}

function sha256Base64Url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

function readGraceSeconds(): number {
  const env = process.env['AUTH_REFRESH_GRACE_SECONDS'];
  if (env === undefined || env.length === 0) return DEFAULT_GRACE_SECONDS;
  const n = Number.parseInt(env, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_GRACE_SECONDS;
  return n;
}
