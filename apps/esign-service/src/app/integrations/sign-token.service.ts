import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { JwtAuthGuard } from '@aramo/auth';
import { SignIntegrationRepository } from '@aramo/esign';
import { TenantEntitlementReader } from '@aramo/identity';

import {
  SIGN_ACCESS_TOKEN_TTL_SECONDS,
  SIGN_API_AUDIENCE,
  digest,
  newAccessToken,
  secretMatches,
} from './credentials.js';
import { effectiveAuthority, type ApplicationView, type IntegrationMode } from './effective-authority.js';

// Sign Unified Product S-4 (directive §4.4.2 – §4.4.3) — the Sign token endpoint.
//
//   client_credentials   APPLICATION mode. The credential is bound to ONE
//                        installation (tenant). The principal is the installation's
//                        integration identity holding the Sign role a Sign admin set.
//   token-exchange       USER mode. The application presents its user's Aramo
//                        access token (subject_token). Sign verifies it with the
//                        shared identity infrastructure and resolves the user's
//                        authority server-side — never from caller fields.
//
// The issued token is opaque, short-lived (≤ 5 minutes and never beyond the
// subject token), audience-bound (aramo-sign-api), tenant-scoped (one
// installation), revocable (installation / credential revocation revokes it) and
// stored only as a digest. Refusals never say whether a client id exists.

export const GRANT_CLIENT_CREDENTIALS = 'client_credentials';
export const GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

// Consumers whose user sessions may be delegated to Sign. Never platform
// operators, portal sessions or ingestion credentials.
const DELEGABLE_CONSUMERS = new Set(['recruiter', 'org', 'esign']);

// A first-party application is installed automatically (recorded, revocable —
// D-8) only in tenants holding these capabilities.
const FIRST_PARTY_ELIGIBILITY: Record<string, readonly string[]> = { 'aramo-ats': ['ats', 'esign'] };

export interface TokenRequest {
  grant_type?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  scope?: unknown;
  subject_token?: unknown;
  subject_token_type?: unknown;
  external_role?: unknown;
  external_actor?: unknown;
}

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
  tenant_id: string;
  installation_id: string;
  mode: IntegrationMode;
}

function refuse(code: 'AUTH_REQUIRED' | 'INSUFFICIENT_PERMISSIONS' | 'VALIDATION_ERROR', status: number, reason: string, requestId: string, message: string): AramoError {
  return new AramoError(code, message, status, { requestId, details: { reason } });
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

@Injectable()
export class SignTokenService {
  private readonly log = new Logger(SignTokenService.name);

  constructor(
    private readonly repo: SignIntegrationRepository,
    private readonly jwt: JwtAuthGuard,
    private readonly entitlements: TenantEntitlementReader,
  ) {}

  async issue(req: TokenRequest, requestId: string): Promise<TokenResponse> {
    const client_id = str(req.client_id, 200);
    const client_secret = str(req.client_secret, 200);
    if (client_id === undefined || client_secret === undefined) {
      throw refuse('AUTH_REQUIRED', 401, 'invalid_client', requestId, 'Client authentication failed');
    }
    const cred = await this.repo.findCredentialByClientId(client_id);
    const now = new Date();
    if (
      cred === null ||
      cred.status !== 'ACTIVE' ||
      (cred.expires_at !== null && cred.expires_at <= now) ||
      !secretMatches(client_secret, cred.secret_hash)
    ) {
      throw refuse('AUTH_REQUIRED', 401, 'invalid_client', requestId, 'Client authentication failed');
    }
    const app = cred.application;
    if (app.status !== 'ACTIVE') throw refuse('AUTH_REQUIRED', 401, 'invalid_client', requestId, 'Client authentication failed');

    const scopeParam = req.scope;
    if (scopeParam !== undefined && (typeof scopeParam !== 'string' || scopeParam.length > 1000)) {
      throw refuse('VALIDATION_ERROR', 400, 'invalid_scope', requestId, 'scope must be a space-separated string');
    }
    const requested = typeof scopeParam === 'string' && scopeParam.trim() !== '' ? scopeParam.trim().split(/\s+/) : undefined;
    const appView: ApplicationView = {
      key: app.key,
      kind: app.kind,
      status: app.status,
      requested_permissions: app.requested_permissions,
      modes: app.modes,
      assertable_roles: app.assertable_roles,
      delegation_profile: app.delegation_profile,
      delegation_required_scope: app.delegation_required_scope,
    };

    let mode: IntegrationMode;
    let tenant_id: string;
    let subject_id: string;
    let installation;
    let ttl = SIGN_ACCESS_TOKEN_TTL_SECONDS;
    let external_role: string | null = null;
    let external_actor: string | null = null;
    let authority;

    if (req.grant_type === GRANT_CLIENT_CREDENTIALS) {
      mode = 'APPLICATION';
      if (cred.installation_id === null) {
        throw refuse('VALIDATION_ERROR', 400, 'unauthorized_client', requestId, 'This client may only act on behalf of a signed-in user');
      }
      installation = await this.repo.findInstallationById(cred.installation_id);
      if (installation === null) throw refuse('AUTH_REQUIRED', 401, 'invalid_client', requestId, 'Client authentication failed');
      tenant_id = installation.tenant_id;
      subject_id = installation.id;
      if (req.external_role !== undefined) {
        const r = str(req.external_role, 64);
        if (r === undefined) throw refuse('VALIDATION_ERROR', 400, 'invalid_request', requestId, 'external_role must be a short string');
        external_role = r;
      }
      if (req.external_actor !== undefined) {
        const a = str(req.external_actor, 200);
        if (a === undefined) throw refuse('VALIDATION_ERROR', 400, 'invalid_request', requestId, 'external_actor must be at most 200 characters');
        external_actor = a;
      }
      await this.assertEntitled(tenant_id, requestId);
      authority = effectiveAuthority({
        mode,
        application: appView,
        installation,
        ...(requested !== undefined ? { requested } : {}),
        ...(external_role !== null ? { external_role } : {}),
        role_mappings: new Map(installation.role_mappings.map((m) => [m.external_role, m.sign_role])),
      });
    } else if (req.grant_type === GRANT_TOKEN_EXCHANGE) {
      mode = 'USER';
      const subject_token = str(req.subject_token, 8192);
      if (subject_token === undefined || req.subject_token_type !== TOKEN_TYPE_ACCESS_TOKEN) {
        throw refuse('VALIDATION_ERROR', 400, 'invalid_request', requestId, 'subject_token (an Aramo access token) is required');
      }
      if (req.external_role !== undefined || req.external_actor !== undefined) {
        throw refuse('VALIDATION_ERROR', 400, 'invalid_request', requestId, 'User delegation takes the identity from the subject token only');
      }
      let verified;
      try {
        verified = await this.jwt.verifyAccessToken(subject_token, requestId);
      } catch {
        throw refuse('VALIDATION_ERROR', 400, 'invalid_grant', requestId, 'The subject token is not valid');
      }
      const user = verified.context;
      if (user.actor_kind !== 'user' || !DELEGABLE_CONSUMERS.has(user.consumer_type)) {
        throw refuse('VALIDATION_ERROR', 400, 'invalid_grant', requestId, 'This session cannot be delegated to Aramo Sign');
      }
      tenant_id = user.tenant_id;
      subject_id = user.sub;
      ttl = Math.min(SIGN_ACCESS_TOKEN_TTL_SECONDS, user.exp - Math.floor(now.getTime() / 1000));
      if (ttl <= 0) throw refuse('VALIDATION_ERROR', 400, 'invalid_grant', requestId, 'The subject token is not valid');
      await this.assertEntitled(tenant_id, requestId);
      if (cred.installation_id !== null) {
        installation = await this.repo.findInstallationById(cred.installation_id);
        if (installation === null || installation.tenant_id !== tenant_id) {
          throw refuse('VALIDATION_ERROR', 400, 'invalid_grant', requestId, 'This client is not installed for the user’s organization');
        }
      } else {
        if (app.kind !== 'FIRST_PARTY') throw refuse('AUTH_REQUIRED', 401, 'invalid_client', requestId, 'Client authentication failed');
        installation = await this.firstPartyInstallation(tenant_id, app.id, app.key, app.requested_permissions, app.modes, requestId);
      }
      const user_sign_scopes = await this.jwt.resolveScopesForConsumer(user, 'esign', verified.authz_version, requestId);
      authority = effectiveAuthority({
        mode,
        application: appView,
        installation,
        ...(requested !== undefined ? { requested } : {}),
        user_sign_scopes,
        user_platform_scopes: user.scopes,
      });
    } else {
      throw refuse('VALIDATION_ERROR', 400, 'unsupported_grant_type', requestId, 'Unsupported grant_type');
    }

    if (!authority.ok) {
      this.log.warn(`sign token refused client=${client_id} app=${app.key} tenant=${tenant_id} mode=${mode} reason=${authority.reason} request=${requestId}`);
      throw refuse('INSUFFICIENT_PERMISSIONS', 403, authority.reason, requestId, 'This application is not authorized for that in Aramo Sign');
    }

    const raw = newAccessToken();
    const expires_at = new Date(now.getTime() + ttl * 1000);
    await this.repo.createToken({
      token_hash: digest(raw),
      credential_id: cred.id,
      installation_id: installation.id,
      tenant_id,
      mode,
      subject_id,
      external_actor,
      external_role,
      scopes: authority.scopes,
      audience: SIGN_API_AUDIENCE,
      expires_at,
    });
    await this.repo.touchCredential(cred.id).catch(() => undefined);
    this.log.log(`sign token issued client=${client_id} app=${app.key} tenant=${tenant_id} installation=${installation.id} mode=${mode} subject=${subject_id} scopes=${authority.scopes.join(',')} request=${requestId}`);
    return {
      access_token: raw,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: authority.scopes.join(' '),
      tenant_id,
      installation_id: installation.id,
      mode,
    };
  }

  private async assertEntitled(tenant_id: string, requestId: string): Promise<void> {
    const caps = await this.entitlements.getCapabilities(tenant_id);
    if (!caps.has('esign')) throw refuse('INSUFFICIENT_PERMISSIONS', 403, 'tenant_not_entitled', requestId, 'Aramo Sign is not part of this organization’s plan');
  }

  // D-8 — the first-party installation is established automatically (recorded,
  // revocable) for an eligible tenant; once revoked by a Sign admin it stays revoked.
  private async firstPartyInstallation(tenant_id: string, application_id: string, key: string, requested: string[], modes: string[], requestId: string) {
    const existing = await this.repo.findInstallation(tenant_id, application_id);
    if (existing !== null) return { ...existing, role_mappings: [] };
    const needs = FIRST_PARTY_ELIGIBILITY[key] ?? ['esign'];
    const caps = await this.entitlements.getCapabilities(tenant_id);
    if (!needs.every((c) => caps.has(c))) {
      throw refuse('INSUFFICIENT_PERMISSIONS', 403, 'installation_not_eligible', requestId, 'This application is not available for this organization');
    }
    const created = await this.repo.createFirstPartyIfAbsent({ tenant_id, application_id, grants: requested, modes });
    if (created === null) throw refuse('INSUFFICIENT_PERMISSIONS', 403, 'installation_revoked', requestId, 'This application is not available for this organization');
    this.log.log(`first-party installation established app=${key} tenant=${tenant_id} installation=${created.id} (recorded, revocable)`);
    return { ...created, role_mappings: [] };
  }
}
