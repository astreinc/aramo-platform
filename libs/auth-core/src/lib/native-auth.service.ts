import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import {
  NATIVE_PLATFORMS,
  NativeDeviceSessionService,
  RefreshTokenService,
  RotationRaceError,
  type NativeDeviceSessionDto,
  type NativePlatform,
} from '@aramo/auth-storage';

import { AUDIT_SINK, type AuditSink } from './audit-sink.port.js';
import { CognitoVerificationError, CognitoVerifierService } from './cognito-verifier.service.js';
import { TENANT_ACCESS_DENIED_REASONS } from './host-binding.js';
import { ACCESS_TOKEN_TTL_SECONDS, JwtIssuerService } from './jwt-issuer.service.js';
import { NATIVE_CODE_EXCHANGE, type NativeCodeExchange } from './native-code-exchange.port.js';
import { PRINCIPAL_DIRECTORY, type PrincipalDirectory } from './principal-directory.port.js';
import { readRefreshGraceSeconds, runRefreshReuseCascade } from './refresh-orchestrator.service.js';

// AUTH-SIGNIN-1 Amendment M-A1 (Native Authentication Consumer, LOCKED
// 2026-10-25) — the native token lifecycle for the `sign` consumer (Aramo Sign
// mobile): code exchange, rotated refresh, logout, device-session list/revoke.
//
// The native-client security context (§3.7) replaces browser host binding on
// these endpoints (no browser Host is simulated):
//   - native-client audience  — the ID token's aud is SIGN_NATIVE_COGNITO_CLIENT_ID;
//   - PKCE                    — the app's own code_verifier, checked by Cognito;
//   - nonce integrity         — the ID token's nonce equals the posted nonce, and
//                               a nonce is accepted once (ledger);
//   - redirect-URI binding    — byte-equal to an allow-listed native callback;
//   - code single-use         — a one-way hash ledger refuses a second redemption,
//                               independently of Cognito's own rule (§3.3);
//   - consumer `sign` + tenant/provider policy — the SAME principal resolution as
//                               the browser callback (R1/R2, no JIT, IC-1,
//                               capability `sign`), re-proven at every refresh;
//   - device-session ownership — list/revoke only the caller's own sessions.
//
// Hygiene (§3.9): tokens travel only in response bodies (never cookies, never
// URLs) and are never logged; the controller sets Cache-Control: no-store.

export const NATIVE_CONSUMER = 'sign' as const;
// The consumer recorded on a native refresh token row. Distinct from the browser
// `sign` value so a native refresh token is refused by every browser cookie path
// (refresh: consumer_mismatch; logout: ignored) and a browser token by the native
// refresh — the two credential families cannot stand in for each other.
export const NATIVE_REFRESH_CONSUMER = 'sign_native' as const;
export const DEFAULT_NATIVE_REDIRECT_URIS = [
  'https://sign.aramo.ai/auth/native/callback',
  'aramosign://auth/callback',
] as const;

const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_BYTES = 32;
// Redeemed-code ledger TTL (§3.8 "short TTL"): comfortably longer than a Cognito
// authorization code's own validity, after which Cognito refuses the code anyway.
const CODE_LEDGER_TTL_SECONDS = 15 * 60;
// RFC 7636 §4.1 — code_verifier = 43..128 unreserved characters.
const CODE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NativeDeviceInput {
  installation_id: string;
  platform: NativePlatform;
  app_version: string;
}

export interface NativeTokenRequest {
  code: string;
  code_verifier: string;
  redirect_uri: string;
  nonce: string;
  device: NativeDeviceInput;
}

export interface NativeTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  device_session_id: string;
}

export interface NativeSessionItem {
  device_session_id: string;
  platform: NativePlatform;
  app_version: string;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

// The authenticated native caller (from a verified Bearer access token).
export interface NativeCaller {
  sub: string;
  tenant_id: string;
  dsid: string;
}

export function readNativeClientId(env: Record<string, string | undefined> = process.env): string | null {
  const v = (env['SIGN_NATIVE_COGNITO_CLIENT_ID'] ?? '').trim();
  return v.length > 0 ? v : null;
}

// SIGN_NATIVE_REDIRECT_URIS — comma list; unset/empty → the two registered
// native callbacks. Entries are trimmed; matching is byte-equal (no
// normalisation, no prefix match).
export function readNativeRedirectUris(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env['SIGN_NATIVE_REDIRECT_URIS'];
  if (raw === undefined || raw.trim().length === 0) return [...DEFAULT_NATIVE_REDIRECT_URIS];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function sha256Base64Url(s: string): string {
  return createHash('sha256').update(s).digest('base64url');
}

function invalidRequest(requestId: string, field: string): AramoError {
  return new AramoError('VALIDATION_ERROR', 'Invalid native token request', 400, {
    requestId,
    details: { reason: 'invalid_request', field },
  });
}

function isNonEmptyString(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}

export function parseNativeTokenRequest(body: unknown, requestId: string): NativeTokenRequest {
  if (body === null || typeof body !== 'object') throw invalidRequest(requestId, 'body');
  const b = body as Record<string, unknown>;
  if (!isNonEmptyString(b['code'], 2048)) throw invalidRequest(requestId, 'code');
  if (typeof b['code_verifier'] !== 'string' || !CODE_VERIFIER_RE.test(b['code_verifier'])) {
    throw invalidRequest(requestId, 'code_verifier');
  }
  if (!isNonEmptyString(b['redirect_uri'], 2048)) throw invalidRequest(requestId, 'redirect_uri');
  if (!isNonEmptyString(b['nonce'], 512)) throw invalidRequest(requestId, 'nonce');
  const d = b['device'];
  if (d === null || typeof d !== 'object') throw invalidRequest(requestId, 'device');
  const dev = d as Record<string, unknown>;
  if (!isNonEmptyString(dev['installation_id'], 200)) throw invalidRequest(requestId, 'device.installation_id');
  if (typeof dev['platform'] !== 'string' || !(NATIVE_PLATFORMS as readonly string[]).includes(dev['platform'])) {
    throw invalidRequest(requestId, 'device.platform');
  }
  if (!isNonEmptyString(dev['app_version'], 64)) throw invalidRequest(requestId, 'device.app_version');
  return {
    code: b['code'],
    code_verifier: b['code_verifier'],
    redirect_uri: b['redirect_uri'],
    nonce: b['nonce'],
    device: {
      installation_id: dev['installation_id'],
      platform: dev['platform'] as NativePlatform,
      app_version: dev['app_version'],
    },
  };
}

export function parseRefreshTokenBody(body: unknown, requestId: string): string {
  const v = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['refresh_token'] : undefined;
  if (!isNonEmptyString(v, 512)) {
    throw new AramoError('VALIDATION_ERROR', 'refresh_token is required', 400, {
      requestId,
      details: { reason: 'invalid_request', field: 'refresh_token' },
    });
  }
  return v;
}

// The principal-resolution denials, mapped to the SAME error codes the browser
// callback uses (auth.controller.ts) — a JSON body here, never a redirect.
export function principalDenialError(reason: string, requestId: string): AramoError {
  const details = { reason };
  if (TENANT_ACCESS_DENIED_REASONS.has(reason)) {
    return new AramoError(
      'TENANT_ACCESS_DENIED',
      reason === 'no_active_tenant' ? 'No active tenant membership' : 'Tenant access denied',
      403,
      { requestId, details },
    );
  }
  if (reason === 'tenant_suspended') {
    return new AramoError('TENANT_SUSPENDED', 'Tenant is suspended', 403, { requestId, details });
  }
  if (reason === 'tenant_closed') {
    return new AramoError('TENANT_CLOSED', 'Tenant is closed', 403, { requestId, details });
  }
  if (reason === 'consumer_not_entitled') {
    return new AramoError('TENANT_CAPABILITY_NOT_ENTITLED', 'Tenant not entitled to this product', 403, {
      requestId,
      details,
    });
  }
  return new AramoError('INSUFFICIENT_PERMISSIONS', 'Identity not provisioned', 403, { requestId, details });
}

function refreshInvalid(reason: string, requestId: string): AramoError {
  return new AramoError('REFRESH_TOKEN_INVALID', 'Refresh token invalid', 401, {
    requestId,
    details: { reason },
  });
}

@Injectable()
export class NativeAuthService {
  private readonly logger = new Logger(NativeAuthService.name);

  constructor(
    @Inject(NATIVE_CODE_EXCHANGE) private readonly exchanger: NativeCodeExchange,
    private readonly cognito: CognitoVerifierService,
    @Inject(PRINCIPAL_DIRECTORY) private readonly principals: PrincipalDirectory,
    private readonly refreshTokens: RefreshTokenService,
    private readonly deviceSessions: NativeDeviceSessionService,
    private readonly jwtIssuer: JwtIssuerService,
    @Inject(AUDIT_SINK) private readonly auditSink: AuditSink,
  ) {}

  private requireClientId(requestId: string): string {
    const clientId = readNativeClientId();
    if (clientId === null) {
      throw new AramoError('INTERNAL_ERROR', 'Native sign-in is not configured', 500, {
        requestId,
        details: { reason: 'native_client_not_configured' },
      });
    }
    return clientId;
  }

  // POST /auth/native/sign/token
  async exchange(req: NativeTokenRequest, requestId: string): Promise<NativeTokenResponse> {
    const clientId = this.requireClientId(requestId);

    // Redirect-URI binding — byte-equal to an allow-listed native callback,
    // checked before the code is touched.
    if (!readNativeRedirectUris().includes(req.redirect_uri)) {
      throw new AramoError('VALIDATION_ERROR', 'redirect_uri is not a registered native callback', 400, {
        requestId,
        details: { reason: 'redirect_uri_not_allowed' },
      });
    }

    // Single-use: the code (and its nonce) are burned BEFORE the exchange, so a
    // concurrent or later second presentation — from any device, client or
    // redirect URI — is refused even while the first is in flight, and a failed
    // exchange cannot be retried with the same code.
    const outcome = await this.deviceSessions.redeemCode({
      code_hash: sha256Base64Url(req.code),
      nonce_hash: sha256Base64Url(req.nonce),
      client_id: clientId,
      expires_at: new Date(Date.now() + CODE_LEDGER_TTL_SECONDS * 1000),
    });
    if (outcome !== 'redeemed') {
      this.logger.warn(JSON.stringify({ event: 'auth.native', stage: 'code_ledger', outcome }));
      throw new AramoError('INVALID_TOKEN', 'Authorization code already used', 401, {
        requestId,
        details: { reason: outcome },
      });
    }

    const exchanged = await this.exchanger.exchange({
      code: req.code,
      code_verifier: req.code_verifier,
      redirect_uri: req.redirect_uri,
      client_id: clientId,
    });
    if (exchanged.kind === 'rejected') {
      // PKCE mismatch, expired/used code, redirect differing from the authorize
      // request — Cognito's invalid_grant family. A client fault.
      this.logger.warn(JSON.stringify({ event: 'auth.native', stage: 'exchange', outcome: 'rejected', oauth_error: exchanged.oauth_error }));
      throw new AramoError('INVALID_TOKEN', 'Authorization code rejected', 401, {
        requestId,
        details: { reason: 'code_exchange_rejected', oauth_error: exchanged.oauth_error },
      });
    }
    if (exchanged.kind === 'unavailable') {
      this.logger.warn(`native cognito exchange failed: ${exchanged.detail}`);
      throw new AramoError('INTERNAL_ERROR', 'Sign-in failed', 500, {
        requestId,
        details: { reason: 'cognito_exchange_failed' },
      });
    }

    let verified;
    try {
      verified = await this.cognito.verify(exchanged.id_token, { audience: clientId, nonce: req.nonce });
    } catch (err) {
      if (err instanceof CognitoVerificationError) {
        throw new AramoError('INVALID_TOKEN', 'IdP token rejected', 401, {
          requestId,
          details: { reason: err.reason },
        });
      }
      this.logger.warn(`native cognito verification failed: ${(err as Error).message}`);
      throw new AramoError('INTERNAL_ERROR', 'Sign-in failed', 500, {
        requestId,
        details: { reason: 'cognito_verification_failed' },
      });
    }

    // The SAME principal resolution as the browser callback (reconcile, no JIT,
    // R1/R2 provider policy, IC-1, status, capability `sign`), minus browser host
    // binding (client: 'native').
    const resolution = await this.principals.resolveSession({
      provider: 'cognito',
      provider_subject: verified.sub,
      verified_email: verified.email,
      consumer: NATIVE_CONSUMER,
      idp: verified.idp,
      client: 'native',
    });
    if (resolution.kind === 'denied') {
      throw principalDenialError(resolution.reason, requestId);
    }
    const siteId = resolution.claims?.['site_id'] ?? null;

    const refreshPlain = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    let created;
    try {
      created = await this.deviceSessions.createSession({
        user_id: resolution.principal_id,
        tenant_id: resolution.context_id,
        consumer_type: NATIVE_CONSUMER,
        refresh_consumer_type: NATIVE_REFRESH_CONSUMER,
        client_id: clientId,
        installation_id: req.device.installation_id,
        platform: req.device.platform,
        app_version: req.device.app_version,
        token_hash: sha256Base64Url(refreshPlain),
        expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      });
    } catch (err) {
      this.logger.warn(`native device session persist failed: ${(err as Error).message}`);
      throw new AramoError('INTERNAL_ERROR', 'Sign-in failed', 500, {
        requestId,
        details: { reason: 'refresh_token_persist_failed' },
      });
    }

    const accessToken = await this.mint(
      {
        sub: resolution.principal_id,
        tenant_id: resolution.context_id,
        authz_version: resolution.authz_version,
        site_id: siteId,
        dsid: created.session.id,
      },
      requestId,
    );

    await this.auditSink.record({
      event_type: 'identity.session.issued',
      actor_id: resolution.principal_id,
      context_id: resolution.context_id,
      subject_id: resolution.principal_id,
      payload: {
        refresh_token_id: created.refresh_token_id,
        ...this.nativeAuditContext(created.session),
      },
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshPlain,
      device_session_id: created.session.id,
    };
  }

  // POST /auth/native/sign/refresh — the refresh token is the only credential;
  // the device session is resolved server-side from it.
  async refresh(refreshToken: string, requestId: string): Promise<NativeTokenResponse> {
    const clientId = this.requireClientId(requestId);
    const found = await this.refreshTokens.findByHash({ token_hash: sha256Base64Url(refreshToken) });
    if (found === null) throw refreshInvalid('not_found', requestId);
    if (Date.parse(found.expires_at) <= Date.now()) throw refreshInvalid('expired', requestId);
    if (found.consumer_type !== NATIVE_REFRESH_CONSUMER) throw refreshInvalid('consumer_mismatch', requestId);
    if (found.revoked_at !== null && found.replaced_by_id === null) {
      throw refreshInvalid('explicitly_revoked', requestId);
    }

    // Reuse of a rotated token → the EXISTING R.2 cascade (revoke every refresh
    // token of the user + identity.session.reuse_detected), and every native
    // device session of the user is closed with it.
    const isReuse = await this.refreshTokens.detectReuse({ token: found, grace_seconds: readRefreshGraceSeconds() });
    if (isReuse) {
      await runRefreshReuseCascade(
        { refreshTokens: this.refreshTokens, auditSink: this.auditSink, logger: this.logger },
        found,
        { client: 'native' },
      );
      try {
        await this.deviceSessions.revokeAllForUser({ user_id: found.user_id, reason: 'reuse_detected' });
      } catch (err) {
        this.logger.warn(`native reuse cascade session revoke failed: ${(err as Error).message}`);
      }
      throw refreshInvalid('reuse_detected', requestId);
    }

    const session = await this.deviceSessions.findActiveByCurrentToken(found.id);
    if (session === null) {
      // A rotated-away token inside the grace window (a retried refresh) races
      // the rotation; otherwise the device session is gone.
      throw refreshInvalid(found.replaced_by_id !== null ? 'rotation_race' : 'device_session_revoked', requestId);
    }
    // Consumer + client binding re-checked at every refresh.
    if (session.consumer_type !== NATIVE_CONSUMER || session.client_id !== clientId) {
      await this.revokeQuietly(session, 'client_mismatch');
      throw refreshInvalid('client_mismatch', requestId);
    }

    // Eligibility + capability `sign` re-proven (IC-2 PR-5/PR-6): a removed
    // entitlement, an inactive membership or a suspended tenant ends the device
    // session; a retained copy of the token can never resume it.
    const resolved = await this.principals.resolveScopes({
      principal_id: session.user_id,
      context_id: session.tenant_id,
      consumer: NATIVE_CONSUMER,
    });
    if (resolved.kind === 'denied') {
      await this.revokeQuietly(session, `refresh_denied:${resolved.reason}`);
      await this.auditSink.record({
        event_type: 'identity.session.revoked',
        actor_id: session.user_id,
        context_id: session.tenant_id,
        subject_id: session.user_id,
        payload: {
          reason: `refresh_denied:${resolved.reason}`,
          refresh_token_id: found.id,
          ...this.nativeAuditContext(session),
        },
      });
      throw refreshInvalid(resolved.reason, requestId);
    }

    const newPlain = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    let rotated;
    try {
      rotated = await this.deviceSessions.rotateForSession({
        session_id: session.id,
        old_token_id: found.id,
        new_token_hash: sha256Base64Url(newPlain),
        new_expires_at: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
      });
    } catch (err) {
      if (err instanceof RotationRaceError) throw refreshInvalid('rotation_race', requestId);
      this.logger.warn(`native refresh rotate failed: ${(err as Error).message}`);
      throw new AramoError('INTERNAL_ERROR', 'Refresh failed', 500, {
        requestId,
        details: { reason: 'refresh_rotate_failed' },
      });
    }

    const accessToken = await this.mint(
      {
        sub: session.user_id,
        tenant_id: session.tenant_id,
        authz_version: resolved.authz_version,
        site_id: resolved.claims?.['site_id'] ?? null,
        dsid: session.id,
      },
      requestId,
    );

    await this.auditSink.record({
      event_type: 'identity.session.refreshed',
      actor_id: session.user_id,
      context_id: session.tenant_id,
      subject_id: session.user_id,
      payload: {
        old_refresh_token_id: found.id,
        new_refresh_token_id: rotated.new_token_id,
        ...this.nativeAuditContext(session),
      },
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: newPlain,
      device_session_id: session.id,
    };
  }

  // POST /auth/native/sign/logout — idempotent: an unknown, foreign-family or
  // already-revoked token is a silent no-op (204, nothing disclosed).
  async logout(refreshToken: string): Promise<void> {
    const found = await this.refreshTokens.findByHash({ token_hash: sha256Base64Url(refreshToken) });
    if (found === null || found.consumer_type !== NATIVE_REFRESH_CONSUMER) return;
    const session = await this.deviceSessions.findActiveByCurrentToken(found.id);
    if (session === null) return;
    const revoked = await this.deviceSessions.revokeSession({ id: session.id, reason: 'logout' });
    if (!revoked) return;
    await this.auditSink.record({
      event_type: 'identity.session.revoked',
      actor_id: session.user_id,
      context_id: session.tenant_id,
      subject_id: session.user_id,
      payload: { reason: 'native_logout', ...this.nativeAuditContext(session) },
    });
  }

  // The caller's own device session must still be live for any device operation
  // (a revoked device cannot keep managing the account on its residual 900 s
  // access token).
  async assertCallerSessionActive(caller: NativeCaller, requestId: string): Promise<void> {
    const own = await this.deviceSessions.findOwnedActive({
      id: caller.dsid,
      user_id: caller.sub,
      tenant_id: caller.tenant_id,
    });
    if (own === null) {
      throw new AramoError('INVALID_TOKEN', 'Device session is no longer active', 401, {
        requestId,
        details: { reason: 'device_session_revoked' },
      });
    }
  }

  // GET /auth/native/sign/sessions — the caller's own user + tenant only.
  async listSessions(caller: NativeCaller, requestId: string): Promise<{ items: NativeSessionItem[] }> {
    await this.assertCallerSessionActive(caller, requestId);
    const rows = await this.deviceSessions.listActiveForUser({ user_id: caller.sub, tenant_id: caller.tenant_id });
    return {
      items: rows.map((s) => ({
        device_session_id: s.id,
        platform: s.platform,
        app_version: s.app_version,
        created_at: s.created_at,
        last_seen_at: s.last_seen_at,
        current: s.id === caller.dsid,
      })),
    };
  }

  // DELETE /auth/native/sign/sessions/{device_session_id} — owner only; any
  // other id (another user's, another tenant's, revoked, malformed, absent) is
  // the same 404. Revocation kills the refresh-token family.
  async revokeSession(caller: NativeCaller, deviceSessionId: string, requestId: string): Promise<void> {
    await this.assertCallerSessionActive(caller, requestId);
    const notFound = (): AramoError =>
      new AramoError('NOT_FOUND', 'Device session not found', 404, {
        requestId,
        details: { reason: 'device_session_not_found' },
      });
    if (!UUID_RE.test(deviceSessionId)) throw notFound();
    const target = await this.deviceSessions.findOwnedActive({
      id: deviceSessionId,
      user_id: caller.sub,
      tenant_id: caller.tenant_id,
    });
    if (target === null) throw notFound();
    const revoked = await this.deviceSessions.revokeSession({ id: target.id, reason: 'device_revoked' });
    if (!revoked) throw notFound();
    await this.auditSink.record({
      event_type: 'identity.session.revoked',
      actor_id: caller.sub,
      context_id: caller.tenant_id,
      subject_id: caller.sub,
      payload: {
        reason: 'native_device_revoked',
        actor_device_session_id: caller.dsid,
        ...this.nativeAuditContext(target),
      },
    });
  }

  private async revokeQuietly(session: NativeDeviceSessionDto, reason: string): Promise<void> {
    try {
      await this.deviceSessions.revokeSession({ id: session.id, reason });
    } catch (err) {
      this.logger.warn(`native session revoke failed: ${(err as Error).message}`);
    }
  }

  private async mint(
    args: { sub: string; tenant_id: string; authz_version: number; site_id: string | null; dsid: string },
    requestId: string,
  ): Promise<string> {
    try {
      return await this.jwtIssuer.sign({
        sub: args.sub,
        consumer_type: NATIVE_CONSUMER,
        tenant_id: args.tenant_id,
        authz_version: args.authz_version,
        ...(args.site_id !== null ? { site_id: args.site_id } : {}),
        client: 'native',
        dsid: args.dsid,
      });
    } catch (err) {
      this.logger.warn(`native jwt sign failed: ${(err as Error).message}`);
      throw new AramoError('INTERNAL_ERROR', 'Sign-in failed', 500, {
        requestId,
        details: { reason: 'jwt_sign_failed' },
      });
    }
  }

  // §3.7 — the native context recorded in audit (no token material).
  private nativeAuditContext(session: NativeDeviceSessionDto): Record<string, unknown> {
    return {
      client: 'native',
      consumer: NATIVE_CONSUMER,
      device_session_id: session.id,
      platform: session.platform,
      app_version: session.app_version,
    };
  }
}
