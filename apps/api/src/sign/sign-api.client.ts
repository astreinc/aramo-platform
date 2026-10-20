import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { AramoError, type ErrorCode } from '@aramo/common';
import type { SignatureActor } from '@aramo/documents-contracts';

// Sign Unified Product — Addendum S6 (Aramo-Sign-Unified-Product-S6-ATS-Migration-
// Addendum-v1_0-LOCKED): the ATS as an authorized client of the Sign API.
//
//   user-initiated  token exchange: the recruiter's own Aramo access token is the
//                   subject; Sign verifies it and decides the delegated authority.
//   completion      the event-bound grant: the ATS authenticates as its own
//                   first-party client and presents the id of the completion event
//                   Sign delivered to it; Sign scopes the grant from its records.
//
// The ATS client credential (SIGN_ATS_CLIENT_ID / SIGN_ATS_CLIENT_SECRET) and
// every bearer value stay server-side and are never logged. Tokens are cached in
// memory until shortly before they expire, keyed by a DIGEST of the subject token
// (never the token itself).

export const SIGN_GRANT_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const SIGN_GRANT_EVENT = 'urn:aramo:params:oauth:grant-type:sign-event';
const SUBJECT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const REFRESH_MARGIN_MS = 30_000;
const CACHE_MAX = 500;

export interface SignTokenGrant {
  access_token: string;
  expires_in: number;
  tenant_id: string;
  installation_id: string;
  envelope_id?: string;
}

function digest(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('base64url');
}

@Injectable()
export class SignApiClient {
  private readonly logger = new Logger('SignApiClient');
  private readonly cache = new Map<string, { grant: SignTokenGrant; until: number }>();

  baseUrl(): string {
    return (process.env['SIGN_SERVICE_URL'] ?? 'http://localhost:3003').replace(/\/+$/, '');
  }

  private credentials(): { client_id: string; client_secret: string } {
    const client_id = process.env['SIGN_ATS_CLIENT_ID'];
    const client_secret = process.env['SIGN_ATS_CLIENT_SECRET'];
    if (client_id === undefined || client_id === '' || client_secret === undefined || client_secret === '') {
      throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'Aramo Sign is not connected', 409, { requestId: '', details: { reason: 'ats_client_unconfigured' } });
    }
    return { client_id, client_secret };
  }

  private async token(body: Record<string, string>, cacheKey: string): Promise<SignTokenGrant> {
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined && hit.until > Date.now()) return hit.grant;
    const res = await fetch(`${this.baseUrl()}/v1/sign/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...this.credentials(), ...body }),
    });
    const json = (await res.json().catch(() => ({}))) as SignTokenGrant & { error?: { code?: string; message?: string; details?: Record<string, unknown> } };
    if (!res.ok) {
      const reason = (json.error?.details?.['reason'] as string | undefined) ?? `HTTP_${res.status}`;
      this.logger.warn(`sign token refused grant=${body['grant_type']} reason=${reason}`);
      throw new AramoError(
        res.status === 401 || res.status === 403 ? 'ESIGN_SEND_UNAVAILABLE' : ((json.error?.code ?? 'INTERNAL_ERROR') as ErrorCode),
        json.error?.message ?? 'Aramo Sign refused the request',
        res.status === 401 || res.status === 403 ? 409 : res.status,
        { requestId: '', details: { reason } },
      );
    }
    if (this.cache.size >= CACHE_MAX) this.cache.clear();
    this.cache.set(cacheKey, { grant: json, until: Date.now() + json.expires_in * 1000 - REFRESH_MARGIN_MS });
    return json;
  }

  // USER mode — the recruiter's delegated authority for this tenant.
  async userGrant(actor: SignatureActor, tenant_id: string): Promise<SignTokenGrant> {
    const grant = await this.token(
      { grant_type: SIGN_GRANT_TOKEN_EXCHANGE, subject_token: actor.access_token, subject_token_type: SUBJECT_TOKEN_TYPE },
      `user:${digest(actor.access_token)}`,
    );
    // Defence in depth: the delegated tenant (decided by Sign from the subject
    // token) must be the tenant this ATS request is acting in.
    if (grant.tenant_id !== tenant_id) {
      throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'Aramo Sign delegated a different organization', 409, { requestId: '', details: { reason: 'tenant_mismatch' } });
    }
    return grant;
  }

  // APPLICATION mode — the event-bound executed-artifact read grant.
  async eventGrant(event_id: string, tenant_id: string, envelope_id: string): Promise<SignTokenGrant> {
    const grant = await this.token({ grant_type: SIGN_GRANT_EVENT, event_id }, `event:${event_id}`);
    if (grant.tenant_id !== tenant_id || grant.envelope_id !== envelope_id) {
      throw new Error(`event grant scope mismatch for event ${event_id}`);
    }
    return grant;
  }

  async call<T>(method: 'GET' | 'POST', path: string, grant: SignTokenGrant, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl()}${path}`, {
      method,
      headers: { authorization: `Bearer ${grant.access_token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json: unknown = text.length > 0 ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error;
      throw new AramoError((err?.code ?? 'INTERNAL_ERROR') as ErrorCode, err?.message ?? 'Aramo Sign error', res.status, {
        requestId: '',
        ...(err?.details !== undefined ? { details: err.details } : {}),
      });
    }
    return json as T;
  }
}
