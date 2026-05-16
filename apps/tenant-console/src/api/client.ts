// Thin fetch wrapper that always sends HttpOnly session cookies.
//
// PR-8 §4.2: apps/auth-service issues HttpOnly cookies on
// /auth/recruiter/callback. The browser cannot read them; it can only
// attach them via credentials: 'include'. All API calls from the
// console MUST go through this client so the cookie attaches.

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
}

export class ApiClient {
  private readonly baseUrl: string;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? '';
  }

  async get<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>('GET', path, init);
  }

  async post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>('POST', path, {
      ...init,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  }

  private async request<T>(
    method: string,
    path: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      method,
      credentials: 'include',
    });

    if (!response.ok) {
      throw new ApiError(
        response.status,
        `Request failed: ${method} ${path} → ${response.status}`,
      );
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

export const apiClient = new ApiClient();
