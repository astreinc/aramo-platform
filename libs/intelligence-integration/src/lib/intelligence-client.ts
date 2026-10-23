import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  SOURCE_SYSTEM_ARAMO_ATS,
  type ConfirmVerificationResponse,
  type CreateVerificationRequest,
  type CreateVerificationResponse,
  type EntitlementSyncRequest,
  type EntitlementSyncResponse,
  type IntelligenceProfileReadResponse,
  type ServiceTokenResponse,
  type TalentErasedRequest,
  type TalentErasedResponse,
  type TalentIngestRequest,
  type TalentIngestResponse,
} from '@aramo/intelligence-contracts';

import { INTELLIGENCE_INTEGRATION_CONFIG, type IntelligenceIntegrationConfig } from './intelligence-config.js';

// ATI-SEP-1 T8 (ADR-0036 §3 "Service auth (E-2)") — the ATS's ONLY channel to
// Talent Intelligence: HTTP + @aramo/intelligence-contracts DTOs (the A7 wall —
// no scope:intelligence import). A client_credentials token from
// POST /v1/oauth/token is cached until shortly before it expires; a 401 from a
// TI route drops it and retries the call once with a fresh token.
//
// Every call has a hard timeout (INTELLIGENCE_HTTP_TIMEOUT_MS, default 5 s) and
// fails with a TYPED error:
//   IntelligenceNotConfiguredError — URL / credentials unset (callers no-op);
//   IntelligenceUnavailableError   — network, timeout, 5xx, 429 (retryable);
//   IntelligenceRejectedError      — any other 4xx (status + TI error code).
// This client is NEVER called from an ATS create / update request path: the
// publisher runs in the worker's outbox drain, the inbound sync in the worker's
// inbox drain, and only the opt-in portal verification route calls it inline.

export class IntelligenceNotConfiguredError extends Error {
  constructor() {
    super('Talent Intelligence is not configured (INTELLIGENCE_SERVICE_URL / INTELLIGENCE_ATS_CLIENT_ID / INTELLIGENCE_ATS_CLIENT_SECRET)');
    this.name = 'IntelligenceNotConfiguredError';
  }
}

export class IntelligenceUnavailableError extends Error {
  readonly retryable = true;
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'IntelligenceUnavailableError';
  }
}

export class IntelligenceRejectedError extends Error {
  readonly retryable = false;
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'IntelligenceRejectedError';
  }
}

export type IntelligenceFetch = (input: string, init: RequestInit) => Promise<Response>;
/** DI token — overridable fetch (tests). Defaults to globalThis.fetch. */
export const INTELLIGENCE_FETCH = 'INTELLIGENCE_FETCH';

/** Refresh the token this many seconds before it expires. */
const TOKEN_REFRESH_MARGIN_SEC = 60;

interface CachedToken {
  value: string;
  expiresAtMs: number;
}

@Injectable()
export class IntelligenceClient {
  private token: CachedToken | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private readonly fetchImpl: IntelligenceFetch;

  constructor(
    @Inject(INTELLIGENCE_INTEGRATION_CONFIG) private readonly config: IntelligenceIntegrationConfig,
    @Optional() @Inject(INTELLIGENCE_FETCH) fetchImpl?: IntelligenceFetch,
    @Optional() @Inject('INTELLIGENCE_CLOCK') private readonly now: () => number = Date.now,
  ) {
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  get configured(): boolean {
    return this.config.configured;
  }

  // ── API surface ────────────────────────────────────────────────────────────

  ingestTalent(body: TalentIngestRequest): Promise<TalentIngestResponse> {
    return this.call<TalentIngestResponse>('POST', '/v1/ingest/talent', body);
  }

  ingestErased(body: TalentErasedRequest): Promise<TalentErasedResponse> {
    return this.call<TalentErasedResponse>('POST', '/v1/ingest/talent/erased', body);
  }

  syncEntitlements(body: EntitlementSyncRequest): Promise<EntitlementSyncResponse> {
    return this.call<EntitlementSyncResponse>('POST', '/v1/entitlements/sync', body);
  }

  readProfile(args: { tenant_id: string; talent_id: string }): Promise<IntelligenceProfileReadResponse> {
    const path =
      `/v1/references/${encodeURIComponent(SOURCE_SYSTEM_ARAMO_ATS)}` +
      `/${encodeURIComponent(args.tenant_id)}/${encodeURIComponent(args.talent_id)}/profile`;
    return this.call<IntelligenceProfileReadResponse>('GET', path);
  }

  requestVerification(body: CreateVerificationRequest): Promise<CreateVerificationResponse> {
    return this.call<CreateVerificationResponse>('POST', '/v1/verifications', body);
  }

  confirmVerification(verificationId: string, code: string): Promise<ConfirmVerificationResponse> {
    return this.call<ConfirmVerificationResponse>('POST', `/v1/verifications/${encodeURIComponent(verificationId)}/confirm`, { code });
  }

  /** Drop the cached token (tests / credential rotation). */
  resetToken(): void {
    this.token = null;
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.config.configured) throw new IntelligenceNotConfiguredError();
    const first = await this.send(method, path, body, await this.accessToken());
    if (first.status !== 401) return this.parse<T>(first);
    // The token was rejected (rotated secret, TI restart with a new signing key):
    // fetch a fresh one and retry exactly once.
    this.token = null;
    return this.parse<T>(await this.send(method, path, body, await this.accessToken()));
  }

  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached !== null && cached.expiresAtMs > this.now()) return cached.value;
    if (this.tokenInFlight !== null) return this.tokenInFlight;
    this.tokenInFlight = this.exchange().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async exchange(): Promise<string> {
    const res = await this.send('POST', '/v1/oauth/token', {
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    const parsed = await this.parse<ServiceTokenResponse>(res);
    if (typeof parsed?.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new IntelligenceUnavailableError('token exchange returned no access_token', res.status);
    }
    const ttl = Number.isFinite(parsed.expires_in) && parsed.expires_in > 0 ? parsed.expires_in : 300;
    const usable = Math.max(30, ttl - TOKEN_REFRESH_MARGIN_SEC);
    this.token = { value: parsed.access_token, expiresAtMs: this.now() + usable * 1000 };
    return parsed.access_token;
  }

  private async send(method: 'GET' | 'POST', path: string, body: unknown, bearer?: string): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (bearer !== undefined) headers['authorization'] = `Bearer ${bearer}`;
    try {
      return await this.fetchImpl(`${this.config.serviceUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      // Never the URL's query, never a body value — the path + reason only.
      throw new IntelligenceUnavailableError(
        timedOut ? `Talent Intelligence ${method} ${path} timed out after ${this.config.timeoutMs} ms` : `Talent Intelligence ${method} ${path} unreachable`,
      );
    }
  }

  private async parse<T>(res: Response): Promise<T> {
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.status >= 200 && res.status < 300) return json as T;
    if (res.status >= 500 || res.status === 429 || res.status === 408) {
      throw new IntelligenceUnavailableError(`Talent Intelligence answered ${res.status}`, res.status);
    }
    const { code, message, details } = errorOf(json);
    throw new IntelligenceRejectedError(res.status, code, message, details);
  }
}

/** TI error bodies: { error: { code, message, ... } } (API) or { error, error_description } (OAuth). */
function errorOf(json: unknown): { code: string; message: string; details: Record<string, unknown> } {
  if (json !== null && typeof json === 'object') {
    const e = (json as Record<string, unknown>)['error'];
    if (e !== null && typeof e === 'object') {
      const { code, message, ...rest } = e as Record<string, unknown>;
      return {
        code: typeof code === 'string' ? code : 'UNKNOWN',
        message: typeof message === 'string' ? message : 'refused',
        details: rest,
      };
    }
    if (typeof e === 'string') {
      const d = (json as Record<string, unknown>)['error_description'];
      return { code: e, message: typeof d === 'string' ? d : e, details: {} };
    }
  }
  return { code: 'UNKNOWN', message: 'refused', details: {} };
}
