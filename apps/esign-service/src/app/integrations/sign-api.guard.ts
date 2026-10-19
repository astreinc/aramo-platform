import { applyDecorators, CanActivate, ExecutionContext, Injectable, UseGuards } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { SignIntegrationRepository } from '@aramo/esign';
import { TenantEntitlementReader } from '@aramo/identity';
import type { Request } from 'express';

import { SIGN_API_AUDIENCE, digest } from './credentials.js';

// Sign Unified Product S-4 — the guard of the Sign API (/v1/esign/api/*). It
// accepts ONLY an integration access token issued by the Sign token endpoint
// (never a session cookie, never an Aramo user JWT) and re-checks, on every call:
// the token (digest match, audience, not expired, not revoked), its credential,
// installation and application (all still ACTIVE), and that the tenant still
// holds `esign`. It then sets the request principal for RolesGuard / the
// services: tenant and subject from the token record — never from the request.

export interface SignIntegrationContext {
  application_key: string;
  application_kind: string;
  installation_id: string;
  mode: 'USER' | 'APPLICATION';
  external_actor: string | null;
  external_role: string | null;
  // Addendum S6 — an EVENT_ARTIFACT grant is bound to ONE envelope's executed artifacts.
  grant_kind: 'STANDARD' | 'EVENT_ARTIFACT';
  bound_envelope_id: string | null;
}

export type SignApiRequest = Request & { authContext?: AuthContextType; signIntegration?: SignIntegrationContext; requestId?: string };

function unauthorized(requestId: string, reason: string): AramoError {
  return new AramoError('AUTH_REQUIRED', 'A valid Aramo Sign access token is required', 401, { requestId, details: { reason } });
}

@Injectable()
export class SignApiGuard implements CanActivate {
  constructor(
    private readonly repo: SignIntegrationRepository,
    private readonly entitlements: TenantEntitlementReader,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<SignApiRequest>();
    const requestId = req.requestId ?? 'unknown';
    const m = /^Bearer\s+(sgt_[A-Za-z0-9_-]{20,})$/.exec(req.header('authorization') ?? '');
    if (m === null || m[1] === undefined) throw unauthorized(requestId, 'missing_or_malformed_token');
    const row = await this.repo.findTokenByHash(digest(m[1]));
    const now = new Date();
    if (row === null) throw unauthorized(requestId, 'unknown_token');
    if (row.audience !== SIGN_API_AUDIENCE) throw unauthorized(requestId, 'wrong_audience');
    if (row.revoked_at !== null) throw unauthorized(requestId, 'token_revoked');
    if (row.expires_at <= now) throw unauthorized(requestId, 'token_expired');
    if (row.credential.status !== 'ACTIVE' || (row.credential.expires_at !== null && row.credential.expires_at <= now)) {
      throw unauthorized(requestId, 'credential_revoked');
    }
    const inst = row.installation;
    if (inst.status !== 'ACTIVE' || inst.tenant_id !== row.tenant_id) throw unauthorized(requestId, 'installation_revoked');
    if (inst.application.status !== 'ACTIVE') throw unauthorized(requestId, 'application_disabled');
    const caps = await this.entitlements.getCapabilities(row.tenant_id);
    if (!caps.has('esign')) {
      throw new AramoError('TENANT_CAPABILITY_NOT_ENTITLED', 'Aramo Sign is not part of this organization’s plan', 403, { requestId, details: { capability: 'esign' } });
    }
    req.authContext = {
      sub: row.subject_id,
      consumer_type: 'esign',
      actor_kind: row.mode === 'USER' ? 'user' : 'service_account',
      tenant_id: row.tenant_id,
      scopes: [...row.scopes],
      iat: Math.floor(row.created_at.getTime() / 1000),
      exp: Math.floor(row.expires_at.getTime() / 1000),
    };
    req.signIntegration = {
      application_key: inst.application.key,
      application_kind: inst.application.kind,
      installation_id: inst.id,
      mode: row.mode as 'USER' | 'APPLICATION',
      external_actor: row.external_actor,
      external_role: row.external_role,
      grant_kind: row.grant_kind === 'EVENT_ARTIFACT' ? 'EVENT_ARTIFACT' : 'STANDARD',
      bound_envelope_id: row.envelope_id,
    };
    return true;
  }
}

// The composed boundary every Sign API route mounts.
export function SignApiBoundary(scope: string): MethodDecorator & ClassDecorator {
  return applyDecorators(UseGuards(SignApiGuard, RolesGuard), RequireScopes(scope));
}
