import { createHash, randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { RefreshTokenService } from '@aramo/auth-storage';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';

import { AUDIT_SINK, type AuditSink } from './audit-sink.port.js';
import type { TenantSelectionTenantDto } from './dto/tenant-selection-error.dto.js';
import {
  CognitoVerifierService,
  CognitoVerificationError,
} from './cognito-verifier.service.js';
import { JwtIssuerService } from './jwt-issuer.service.js';
import { PkceService } from './pkce.service.js';
import {
  PRINCIPAL_DIRECTORY,
  type PrincipalDirectory,
} from './principal-directory.port.js';
import { deriveRedirectUri } from './redirect-uri.js';

// PR-8.0a-Reground §8.2 callback orchestrator. Returns a discriminated
// result; the controller maps each variant to HTTP response, cookies, and
// pkce_state-cookie clearing. Best-effort audit emission inside the
// success branch (failure does not block the flow per §3 Topic 1).

const PKCE_TTL_SECONDS = 600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_BYTES = 32;

// FIX-PORTAL-SCOPES-1 (D1) — the scope set stamped on a portal session. This is
// the SINGLE SOURCE OF TRUTH for a real portal JWT's scopes; RolesGuard checks the
// JWT claim, so this list MUST carry every portal:* scope any portal surface
// demands (reads AND writes), or that surface 403s against a real session (the
// F-P4b-1 bug: this was a stale 2-read-scope list while P2/P3 shipped write
// surfaces). It must stay ≡ the portal:* scopes the portal role is granted in the
// libs/identity seed — a structural parity test
// (session-scope-parity.spec) asserts that, derived programmatically, so it can
// never silently drift again. ADD-not-rename: a new seed portal:* scope (once its
// role grant lands) is added here + the parity test keeps the two in lockstep.
export const PORTAL_SESSION_SCOPES: string[] = [
  'portal:profile:read',
  'portal:profile:edit',
  'portal:consent:read',
  'portal:consent:write',
  'portal:verification:read',
  'portal:dispute:read',
  'portal:dispute:write',
];

export interface CallbackInput {
  // AUTHZ-2: 'platform' is the 4th consumer_type (Lead ruling 3 —
  // extend auth-service, no second auth stack). At Gate 6 the platform
  // login flow uses the SEPARATE Cognito user pool (Lead ruling 4 A1);
  // the env-var routing per-consumer is a readiness-track follow-on
  // (real Cognito + IAM + 2 pools before PROD), since the proofs use
  // JwtIssuerService directly to mint platform JWTs (mocked Cognito).
  consumer: 'recruiter' | 'portal' | 'ingestion' | 'platform';
  code: string | undefined;
  state: string | undefined;
  cognitoError: string | undefined;
  cognitoErrorDescription: string | undefined;
  pkceStateCipher: string | undefined;
  // PR-3.1 §3d.1: the base derived from the callback request's VALIDATED host
  // (null for an unvalidated host → the exchange redirect_uri falls back to the
  // env chain). The controller computes it (sharing one lookup) and threads it
  // here so the exchange redirect_uri == the authorize redirect_uri.
  derivedBase?: string | null;
}

export type CallbackResult =
  | {
      kind: 'success';
      accessJwt: string;
      refreshTokenPlaintext: string;
    }
  | {
      kind: 'validation_error';
      reason: string;
      cognitoError?: string;
      cognitoErrorDescription?: string;
    }
  | {
      kind: 'tenant_selection_required';
      tenants: TenantSelectionTenantDto[];
    }
  // §5 Auth-Hardening D2 P4: user/config-class failures (a rejected IdP
  // token, an identity that is not provisioned, no active membership) — the
  // controller maps these to a clean 4xx with details.reason so the first
  // login is debuggable, NOT a blank 500. Distinct from internal_error,
  // which stays reserved for genuine server/infra faults (token-exchange,
  // refresh-token persist, JWT sign, JWKS/network verification failures).
  | {
      kind: 'auth_error';
      reason: string;
    }
  | {
      kind: 'internal_error';
      reason: string;
    };

@Injectable()
export class SessionOrchestratorService {
  private readonly logger = new Logger(SessionOrchestratorService.name);

  constructor(
    private readonly pkce: PkceService,
    private readonly cognito: CognitoVerifierService,
    @Inject(PRINCIPAL_DIRECTORY)
    private readonly principals: PrincipalDirectory,
    private readonly refreshTokens: RefreshTokenService,
    private readonly jwtIssuer: JwtIssuerService,
    @Inject(AUDIT_SINK) private readonly auditSink: AuditSink,
  ) {}

  async handleCallback(input: CallbackInput): Promise<CallbackResult> {
    if (input.cognitoError !== undefined) {
      return {
        kind: 'validation_error',
        reason: 'cognito_error',
        cognitoError: input.cognitoError,
        cognitoErrorDescription: input.cognitoErrorDescription,
      };
    }
    if (input.pkceStateCipher === undefined || input.pkceStateCipher.length === 0) {
      return { kind: 'validation_error', reason: 'pkce_state_missing' };
    }

    let payload;
    try {
      payload = this.pkce.decryptState(input.pkceStateCipher);
    } catch {
      return { kind: 'validation_error', reason: 'pkce_state_decrypt_failed' };
    }
    if (input.state === undefined || payload.state !== input.state) {
      return { kind: 'validation_error', reason: 'state_mismatch' };
    }
    if (payload.consumer !== input.consumer) {
      return { kind: 'validation_error', reason: 'consumer_mismatch' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      payload.issued_at > nowSec ||
      nowSec - payload.issued_at > PKCE_TTL_SECONDS
    ) {
      return { kind: 'validation_error', reason: 'pkce_state_expired' };
    }
    if (input.code === undefined || input.code.length === 0) {
      return { kind: 'validation_error', reason: 'cognito_code_missing' };
    }

    let idToken: string;
    try {
      // Amendment v1.2 (Workstream D): derive the exchange redirect_uri from the
      // consumer validated at callback (input.consumer === payload.consumer here,
      // post consumer-compare) — identical to the login-time derivation, so
      // OAuth's exchange==authorize redirect_uri invariant holds by construction.
      idToken = await this.exchangeCognitoCode(
        input.code,
        payload.verifier,
        input.consumer,
        input.derivedBase,
      );
    } catch (err) {
      this.logger.warn(`cognito exchange failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'cognito_exchange_failed' };
    }

    let cognito;
    try {
      cognito = await this.cognito.verify(idToken);
    } catch (err) {
      this.logger.warn(`cognito verification failed: ${(err as Error).message}`);
      // P4: a token-content rejection (email_not_verified, missing claim,
      // wrong token_use) is a 4xx auth_error; signature / JWKS / network /
      // iss / aud / exp failures (plain Errors from jose) stay 500.
      if (err instanceof CognitoVerificationError) {
        return { kind: 'auth_error', reason: err.reason };
      }
      return { kind: 'internal_error', reason: 'cognito_verification_failed' };
    }

    // Auth-Decoupling PR-4 (ADR-0021 §2): ONE call resolves the verified identity
    // into a session context (R-P4-1). The adapter performs reconcile-by-sub,
    // reconcile-by-verified-email + sub-link, membership activation, tenant
    // selection, status gating, site stamping, and scope resolution — auth no
    // longer knows what a tenant, a site, or a SUSPENDED status is. `consumer`
    // goes TO the port; the adapter decides the platform status-gate exemption.
    // The mapping below is mechanical — CallbackResult + every HTTP response are
    // UNCHANGED (behaviour-preserving, R-P4-3).
    const resolution = await this.principals.resolveSession({
      provider: 'cognito',
      provider_subject: cognito.sub,
      verified_email: cognito.email,
      consumer: input.consumer,
    });
    if (resolution.kind === 'denied') {
      // user_not_provisioned · no_active_tenant · tenant_suspended · tenant_closed
      return { kind: 'auth_error', reason: resolution.reason };
    }
    if (resolution.kind === 'ambiguous') {
      return { kind: 'tenant_selection_required', tenants: resolution.choices };
    }
    // resolved → mint. principal_id/context_id are opaque (a user id / tenant id);
    // site_id rides in claims when a site-scoped membership stamped one.
    const principalId = resolution.principal_id;
    const contextId = resolution.context_id;
    const scopes = resolution.scopes;
    const siteId = resolution.claims?.['site_id'] ?? null;

    const refreshTokenPlaintext = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshTokenHash = sha256Base64Url(refreshTokenPlaintext);
    const expires_at = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    let stored;
    try {
      stored = await this.refreshTokens.create({
        user_id: principalId,
        tenant_id: contextId,
        consumer_type: input.consumer,
        token_hash: refreshTokenHash,
        expires_at,
      });
    } catch (err) {
      this.logger.warn(`refresh token persist failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'refresh_token_persist_failed' };
    }

    let accessJwt: string;
    try {
      accessJwt = await this.jwtIssuer.sign({
        sub: principalId,
        consumer_type: input.consumer,
        tenant_id: contextId,
        scopes,
        ...(siteId !== null ? { site_id: siteId } : {}),
      });
    } catch (err) {
      this.logger.warn(`jwt sign failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'jwt_sign_failed' };
    }

    // session.issued — emitted by AUTH (auth issued the session) via AuditSink.
    await this.auditSink.record({
      event_type: 'identity.session.issued',
      actor_id: principalId,
      context_id: contextId,
      subject_id: principalId,
      payload: { refresh_token_id: stored.id },
    });

    return {
      kind: 'success',
      accessJwt,
      refreshTokenPlaintext,
    };
  }

  private async exchangeCognitoCode(
    code: string,
    verifier: string,
    consumer: CallbackInput['consumer'],
    derivedBase?: string | null,
  ): Promise<string> {
    const domain = process.env['AUTH_COGNITO_DOMAIN'];
    const clientId = process.env['AUTH_COGNITO_CLIENT_ID'];
    // Amendment v1.2 (Workstream D): derive per-consumer, matching the authorize
    // redirect_uri (same consumer, same base). OAuth requires the two be equal.
    // PR-3.1 §3d.1: the validated-host base (threaded from the callback request)
    // wins over the env chain — identical to the login host, so equal.
    const redirectUri = deriveRedirectUri(consumer, derivedBase);
    if (
      domain === undefined ||
      clientId === undefined ||
      redirectUri === null
    ) {
      throw new Error('cognito-exchange-env-missing');
    }
    const url = `https://${domain}/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      // Include Cognito's OAuth error body (e.g. {"error":"invalid_grant"}) in
      // the message — it's server-log only (the orchestrator maps this to a
      // generic 500 for the client) and is the difference between a debuggable
      // and an opaque token-exchange failure. The body carries no secret.
      const errBody = await res.text().catch(() => '');
      throw new Error(
        `cognito-token-status-${res.status}: ${errBody.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as { id_token?: string };
    if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
      throw new Error('cognito-token-missing-id-token');
    }
    return json.id_token;
  }

  /**
   * Portal P1 — establish a passwordless PORTAL session for an already-resolved
   * PortalUser (the caller consumes the login token + finds/mints the user).
   * Platform-STYLE keying (Portal ruling 4): the access JWT and refresh token
   * carry `consumer_type='portal'` and the PLATFORM_TENANT_SENTINEL_ID as
   * tenant_id — portal sessions have NO real tenant, so the sentinel satisfies the
   * required-string tenant contract; consumer_type='portal' is the distinguishing
   * axis, and the real tenant is resolved per-record by the OPEN-4 chain in P2.
   * Reuses the exact JWT + refresh-token keying the Cognito callback uses (same
   * constants, same hashing). No Cognito, no PKCE, and no identity audit — this is
   * a portal-rail event, not an identity-rail one.
   */
  async establishPortalSession(input: {
    portal_user_id: string;
  }): Promise<{ accessJwt: string; refreshTokenPlaintext: string }> {
    const accessJwt = await this.jwtIssuer.sign({
      sub: input.portal_user_id,
      consumer_type: 'portal',
      tenant_id: PLATFORM_TENANT_SENTINEL_ID,
      scopes: PORTAL_SESSION_SCOPES,
    });
    const refreshTokenPlaintext = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshTokenHash = sha256Base64Url(refreshTokenPlaintext);
    const expires_at = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
    await this.refreshTokens.create({
      user_id: input.portal_user_id,
      tenant_id: PLATFORM_TENANT_SENTINEL_ID,
      consumer_type: 'portal',
      token_hash: refreshTokenHash,
      expires_at,
    });
    return { accessJwt, refreshTokenPlaintext };
  }
}

function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}
