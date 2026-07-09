// Thin fetch wrapper that always sends HttpOnly session cookies.
//
// PR-8 §4.2: apps/auth-service issues HttpOnly cookies on
// /auth/recruiter/callback. The browser cannot read them; it can only
// attach them via credentials: 'include'. All API calls from the
// console MUST go through this client so the cookie attaches.
//
// Settings S5a enhancements (the FE precedent for S5b/S5c):
//
//  - ApiError now carries the parsed `code` + `details` from a JSON
//    error body. The backend already produces a rich per-reason
//    taxonomy (VALIDATION_ERROR.details.reason: 'invalid_value' /
//    'invertible_role_union' / 'financials_audit_not_enabled' / etc.);
//    this surface lets the UI render the operator-legible reason
//    instead of the generic 'Request failed: 400'. The parse is
//    best-effort: a non-JSON or empty body falls back to the generic
//    message.
//
//  - PUT / PATCH / DELETE join GET / POST. The settings view needs PUT
//    (S5a); S5b will need PATCH (role-assign); S5c will need DELETE
//    (D4a clears).

import { authPath } from '../auth/consumer';

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
}

// Re-mint path for the silent access-token refresh. Inc-2 PR-2: derived from the
// configured auth consumer (default 'recruiter') via auth/consumer.ts — the same
// single bootstrap point the session.ts paths use — so platform-web refreshes at
// /auth/platform/refresh while ats-web is unchanged. consumer.ts has no import
// cycle with this module (it depends on nothing here).

export class ApiClient {
  private readonly baseUrl: string;
  // Single-flight refresh. When the short-lived (15-min) access cookie
  // expires, the FIRST 401 triggers one POST /refresh; any other in-flight
  // requests that 401 concurrently AWAIT the same refresh instead of each
  // POSTing. This is load-bearing, not just an optimization: the refresh
  // endpoint ROTATES the refresh token, so a second concurrent refresh would
  // spend an already-rotated token and log the user out.
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
  }

  async get<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>('GET', path, init);
  }

  async post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>('POST', path, this.withJsonBody(body, init));
  }

  async put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>('PUT', path, this.withJsonBody(body, init));
  }

  async patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>('PATCH', path, this.withJsonBody(body, init));
  }

  async delete<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>('DELETE', path, init);
  }

  private withJsonBody(body: unknown, init?: RequestInit): RequestInit {
    return {
      ...init,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    };
  }

  private async request<T>(
    method: string,
    path: string,
    init?: RequestInit,
    alreadyRetried = false,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
      credentials: 'include',
    });

    // Refresh-on-401: the access cookie lives 15 min; the refresh cookie
    // lives 30 days. When a call 401s because the access token expired,
    // transparently POST /refresh (re-mints both cookies) and retry the
    // original request ONCE. If refresh fails (refresh token gone too →
    // genuinely unauthenticated), the 401 falls through and is surfaced;
    // the session bootstrap / RouteGuard then route the user to login.
    // Guard: never recurse on the refresh endpoint itself, retry at most once.
    if (
      response.status === 401 &&
      !alreadyRetried &&
      path !== authPath('refresh')
    ) {
      const refreshed = await this.refreshAccess();
      if (refreshed) {
        return this.request<T>(method, path, init, true);
      }
    }

    if (!response.ok) {
      // Best-effort JSON parse: a malformed/empty body must not mask the
      // status code with a thrown SyntaxError. The generic message is
      // the fallback when (a) the body isn't JSON or (b) the backend
      // didn't shape an `error` envelope.
      let parsed: ApiErrorBody | undefined;
      try {
        parsed = (await response.json()) as ApiErrorBody;
      } catch {
        parsed = undefined;
      }
      const err = parsed?.error;
      throw new ApiError(
        response.status,
        err?.message ?? `Request failed: ${method} ${path} → ${response.status}`,
        err?.code,
        err?.details,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  // Single-flight access-token refresh. Returns true iff /refresh succeeded
  // (new access + refresh cookies were set). Concurrent callers share the
  // one in-flight promise; the slot clears when it settles so a later
  // expiry can refresh again.
  private refreshAccess(): Promise<boolean> {
    if (this.refreshInFlight === null) {
      this.refreshInFlight = (async () => {
        try {
          const res = await fetch(`${this.baseUrl}${authPath('refresh')}`, {
            method: 'POST',
            credentials: 'include',
          });
          return res.ok;
        } catch {
          return false;
        }
      })().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }
}

export const apiClient = new ApiClient();
