import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import {
  IdentityAuditService,
  IdentityService,
  RoleService,
  TenantService,
} from '@aramo/identity';
import { RefreshTokenService } from '@aramo/auth-storage';

import type { TenantSelectionTenantDto } from './dto/tenant-selection-error.dto.js';
import { CognitoVerifierService } from './cognito-verifier.service.js';
import { JwtIssuerService } from './jwt-issuer.service.js';
import { PkceService } from './pkce.service.js';

// PR-8.0a-Reground §8.2 callback orchestrator. Returns a discriminated
// result; the controller maps each variant to HTTP response, cookies, and
// pkce_state-cookie clearing. Best-effort audit emission inside the
// success branch (failure does not block the flow per §3 Topic 1).

const PKCE_TTL_SECONDS = 600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN_BYTES = 32;

export interface CallbackInput {
  consumer: 'recruiter' | 'portal' | 'ingestion';
  code: string | undefined;
  state: string | undefined;
  cognitoError: string | undefined;
  cognitoErrorDescription: string | undefined;
  pkceStateCipher: string | undefined;
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
    private readonly identity: IdentityService,
    private readonly tenant: TenantService,
    private readonly role: RoleService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly jwtIssuer: JwtIssuerService,
    private readonly audit: IdentityAuditService,
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
      idToken = await this.exchangeCognitoCode(input.code, payload.verifier);
    } catch (err) {
      this.logger.warn(`cognito exchange failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'cognito_exchange_failed' };
    }

    let cognito;
    try {
      cognito = await this.cognito.verify(idToken);
    } catch (err) {
      this.logger.warn(`cognito verification failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'cognito_verification_failed' };
    }

    const user = await this.identity.resolveUser({
      provider: 'cognito',
      provider_subject: cognito.sub,
    });
    if (user === null) {
      return { kind: 'internal_error', reason: 'user_not_provisioned' };
    }

    const tenants = await this.tenant.getTenantsByUser({ user_id: user.id });
    if (tenants.length === 0) {
      return { kind: 'internal_error', reason: 'no_active_tenant' };
    }
    if (tenants.length > 1) {
      return {
        kind: 'tenant_selection_required',
        tenants: tenants.map((t) => ({ id: t.id, name: t.name })),
      };
    }
    const selectedTenant = tenants[0]!;

    const scopes = await this.role.getScopesByUserAndTenant({
      user_id: user.id,
      tenant_id: selectedTenant.id,
    });

    const refreshTokenPlaintext = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
    const refreshTokenHash = sha256Base64Url(refreshTokenPlaintext);
    const expires_at = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

    let stored;
    try {
      stored = await this.refreshTokens.create({
        user_id: user.id,
        tenant_id: selectedTenant.id,
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
        sub: user.id,
        consumer_type: input.consumer,
        tenant_id: selectedTenant.id,
        scopes,
      });
    } catch (err) {
      this.logger.warn(`jwt sign failed: ${(err as Error).message}`);
      return { kind: 'internal_error', reason: 'jwt_sign_failed' };
    }

    await this.audit.writeEvent({
      event_type: 'identity.session.issued',
      actor_type: 'user',
      actor_id: user.id,
      tenant_id: selectedTenant.id,
      subject_id: user.id,
      payload: { refresh_token_id: stored.id },
    });

    return {
      kind: 'success',
      accessJwt,
      refreshTokenPlaintext,
    };
  }

  private async exchangeCognitoCode(code: string, verifier: string): Promise<string> {
    const domain = process.env['AUTH_COGNITO_DOMAIN'];
    const clientId = process.env['AUTH_COGNITO_CLIENT_ID'];
    const redirectUri = process.env['AUTH_COGNITO_REDIRECT_URI'];
    if (
      domain === undefined ||
      clientId === undefined ||
      redirectUri === undefined
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
      throw new Error(`cognito-token-status-${res.status}`);
    }
    const json = (await res.json()) as { id_token?: string };
    if (typeof json.id_token !== 'string' || json.id_token.length === 0) {
      throw new Error('cognito-token-missing-id-token');
    }
    return json.id_token;
  }
}

function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}
