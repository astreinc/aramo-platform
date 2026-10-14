import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { RefreshTokenService, RotationRaceError } from '@aramo/auth-storage';

import { AUDIT_SINK, type AuditSink } from './audit-sink.port.js';
import {
  allowUnboundHost,
  evaluateSessionHostBinding,
  readHostBindingMode,
  type HostBindingClass,
} from './host-binding.js';
import { JwtIssuerService } from './jwt-issuer.service.js';
import {
  PRINCIPAL_DIRECTORY,
  type PrincipalDirectory,
} from './principal-directory.port.js';

// PR-8.0a-Reground §8.3 refresh orchestrator. Returns a discriminated
// result; the controller maps to HTTP and cookie writes (clearing both
// cookies on every 401 path). Best-effort audit emission.

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_BYTES = 32;
const DEFAULT_GRACE_SECONDS = 30;

export interface RefreshInput {
  // AUTHZ-2: 'platform' is the 4th consumer_type (Lead ruling 3).
  consumer: 'recruiter' | 'portal' | 'ingestion' | 'platform' | 'esign';
  refreshCookie: string | undefined;
  // IC-2 PR-5 — the refresh request's host class + context (HostBaseResolver).
  // Compared with the STORED token tenant under the PR-4 session-surface policy:
  // enforce denies a mismatch / unbound host (fail closed) BEFORE any re-mint;
  // log records a diagnostic and keeps today's outcome. undefined = unbound.
  hostClass?: HostBindingClass | null;
  contextId?: string | null;
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
    @Inject(PRINCIPAL_DIRECTORY)
    private readonly principals: PrincipalDirectory,
    private readonly jwtIssuer: JwtIssuerService,
    @Inject(AUDIT_SINK) private readonly auditSink: AuditSink,
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
      await this.auditSink.record({
        event_type: 'identity.session.reuse_detected',
        actor_id: found.user_id,
        context_id: found.tenant_id,
        subject_id: found.user_id,
        payload: { presented_token_id: found.id },
      });
      return { kind: 'token_invalid', reason: 'reuse_detected' };
    }

    // IC-2 PR-5 — host/tenant binding at refresh (session surface). The stored
    // token's tenant is the domain-owned tenant; the request host must be
    // compatible with it. A platform-sentinel token is served only on the
    // PLATFORM host by the platform consumer; a portal token only on the PORTAL
    // host. Unbound/unvalidated hosts are refused under enforce unless
    // AUTH_ALLOW_UNBOUND_HOST=true. Never a re-mint on an enforced mismatch.
    const binding = evaluateSessionHostBinding({
      host_class: input.hostClass,
      context_id: input.contextId,
      consumer: input.consumer,
      resolved_context_id: found.tenant_id,
      allow_unbound: allowUnboundHost(),
    });
    if (!binding.ok) {
      const mode = readHostBindingMode();
      this.logger.warn(
        JSON.stringify({
          event: 'auth.host_binding',
          stage: 'refresh',
          mode,
          outcome: binding.reason,
          consumer: input.consumer,
          host_class: input.hostClass ?? null,
        }),
      );
      if (mode === 'enforce') {
        return { kind: 'token_invalid', reason: binding.reason };
      }
    }

    // Normal refresh: re-derive scopes, generate new plaintext, rotate.
    //
    // Auth-Decoupling PR-4 (§7.4 Ruling 2): the site-stamp + scope resolution
    // shares the SAME logic session issuance uses, so it moves behind
    // PrincipalDirectory.resolveScopes. site_id is re-derived deterministically
    // from the (user_id, tenant_id) membership (schema @@unique) and rides in
    // claims — byte-identical to the pre-port refresh (PR-A1a-3 Ruling 1/2).
    //
    // IC-2 PR-5 (Amendment A2): resolveScopes now re-proves ELIGIBILITY. A
    // denial (inactive User, no active membership in the stored tenant,
    // SUSPENDED/CLOSED tenant) REVOKES the presented token (best-effort) and
    // is a 401 — a retained cookie copy cannot resume the session later
    // without re-authenticating. Tenant ownership cannot change at re-mint:
    // the only tenant minted is the stored one, and only if the principal's
    // ONE active membership is in it.
    const resolved = await this.principals.resolveScopes({
      principal_id: found.user_id,
      context_id: found.tenant_id,
      consumer: input.consumer,
    });
    if (resolved.kind === 'denied') {
      try {
        await this.refreshTokens.revoke({ id: found.id });
      } catch (err) {
        this.logger.warn(`refresh eligibility revoke failed: ${(err as Error).message}`);
      }
      await this.auditSink.record({
        event_type: 'identity.session.revoked',
        actor_id: found.user_id,
        context_id: found.tenant_id,
        subject_id: found.user_id,
        payload: { reason: `refresh_denied:${resolved.reason}`, refresh_token_id: found.id },
      });
      return { kind: 'token_invalid', reason: resolved.reason };
    }
    // HF-AUTH-1 — re-mint compact: the refreshed token carries the CURRENT authz
    // revision (re-resolved here), not the scope list. A grant/role/membership
    // change since the last mint therefore rides forward as a new version, and the
    // guard resolves the fresh effective scopes server-side.
    const authzVersion = resolved.authz_version;
    const stampedSiteId = resolved.claims?.['site_id'] ?? null;

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
        authz_version: authzVersion,
        ...(stampedSiteId !== null ? { site_id: stampedSiteId } : {}),
      });
    } catch (err) {
      this.logger.warn(`jwt sign on refresh failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'jwt_sign_failed' };
    }

    await this.auditSink.record({
      event_type: 'identity.session.refreshed',
      actor_id: found.user_id,
      context_id: found.tenant_id,
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
