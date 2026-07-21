import { Injectable, Logger, Optional } from '@nestjs/common';

import {
  INDEED_CLIENT_ID_ENV,
  INDEED_CLIENT_SECRET_ENV,
  INDEED_OAUTH_GRANT_TYPE,
  INDEED_OAUTH_SCOPE_DEFAULT,
  INDEED_OAUTH_SCOPE_ENV,
  INDEED_OAUTH_TOKEN_URL,
  INDEED_TOKEN_REFRESH_SKEW_SECONDS,
} from './indeed.constants.js';

// SRC-2 PR-3 (R7) — Indeed OAuth 2-legged (client-credentials) token service.
//
// RECON-2: POST https://apis.indeed.com/oauth/v2/tokens with
// grant_type=client_credentials, scope=employer_access, client_id, client_secret;
// the response carries access_token + expires_in (3600s).
//
// FAIL-CLOSED (R7): if either credential env var is unset/empty the service is
// DISABLED — isConfigured is false and the sweep skips the tick (one log line, no
// token fetch, no crash-loop, no retry storm). In-memory cache with early refresh
// (skew) so an in-flight mutation never rides an about-to-expire token; a single
// in-flight fetch is shared so concurrent callers never stampede the endpoint.
// Pure fetch — no @aramo import, no graphql/oauth dependency.
@Injectable()
export class IndeedTokenService {
  private readonly logger = new Logger(IndeedTokenService.name);

  private cached: { token: string; expiresAtMs: number } | null = null;
  private inFlight: Promise<string> | null = null;

  // Controllable clock so the cache/refresh window is deterministically testable
  // (the spec advances it); defaults to Date.now in production. @Optional so Nest
  // DI injects `undefined` (this is not a provider) and the default clock applies —
  // without it Nest tries to resolve the `Function` param and the module fails to
  // bootstrap.
  constructor(@Optional() private readonly now: () => number = () => Date.now()) {}

  get isConfigured(): boolean {
    return this.clientId.length > 0 && this.clientSecret.length > 0;
  }

  private get clientId(): string {
    return process.env[INDEED_CLIENT_ID_ENV] ?? '';
  }

  private get clientSecret(): string {
    return process.env[INDEED_CLIENT_SECRET_ENV] ?? '';
  }

  private get scope(): string {
    const configured = process.env[INDEED_OAUTH_SCOPE_ENV];
    return configured !== undefined && configured.length > 0
      ? configured
      : INDEED_OAUTH_SCOPE_DEFAULT;
  }

  // Returns a valid access token, fetching/refreshing as needed. Throws if the
  // service is not configured — callers MUST gate on `isConfigured` first (the
  // orchestrator does, logging one skip per tick).
  async getAccessToken(): Promise<string> {
    if (!this.isConfigured) {
      throw new Error('Indeed connector is not configured (credentials unset)');
    }
    const nowMs = this.now();
    if (this.cached !== null && nowMs < this.cached.expiresAtMs) {
      return this.cached.token;
    }
    // Share one in-flight refresh across concurrent callers.
    if (this.inFlight === null) {
      this.inFlight = this.fetchToken().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: INDEED_OAUTH_GRANT_TYPE,
      scope: this.scope,
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    const res = await fetch(INDEED_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const detail = await safeText(res);
      throw new Error(`Indeed token request failed: ${res.status} ${detail}`);
    }

    const json = (await res.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    const token = typeof json.access_token === 'string' ? json.access_token : '';
    if (token.length === 0) {
      throw new Error('Indeed token response missing access_token');
    }
    const expiresInSec =
      typeof json.expires_in === 'number' && json.expires_in > 0
        ? json.expires_in
        : 3600;
    const ttlMs =
      Math.max(expiresInSec - INDEED_TOKEN_REFRESH_SKEW_SECONDS, 1) * 1000;
    this.cached = { token, expiresAtMs: this.now() + ttlMs };
    this.logger.log({ event: 'indeed_token_refreshed', expires_in: expiresInSec });
    return token;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<unreadable>';
  }
}
