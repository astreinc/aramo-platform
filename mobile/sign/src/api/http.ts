// The one low-level HTTP executor both transports use. It knows nothing about
// credentials: each transport (workspaceClient / guestSigningClient) builds its own
// header set from scratch on every request, so nothing can leak between them.
import { ApiError, clientError, errorFromBody } from './errors';
import type { QueryValue } from './types';

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute path beginning with `/`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>> | undefined;
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly data: T;
  /** The ETag header verbatim (M-A3 §6: `"{id}.{revision}"`), or null. */
  readonly etag: string | null;
  readonly headers: Headers;
}

export function buildUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, QueryValue>>,
): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('path must be absolute');
  // No dot segments (raw or percent-encoded) and no empty segments: a path can never be
  // normalised by the HTTP stack into a different route than the one checked.
  if (/(^|\/)\.{1,2}(\/|$)/.test(path) || /%2e|%2f|%5c|\\/i.test(path) || path.includes('//')) {
    throw new Error('path must not contain dot or empty segments');
  }
  const qs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}

async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function execute<T>(
  fetchFn: FetchFn,
  baseUrl: string,
  req: HttpRequest,
): Promise<HttpResponse<T>> {
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  const url = buildUrl(baseUrl, req.path, req.query);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: req.method,
      headers,
      // No transport relies on cookies (Bearer or capability token only).
      credentials: 'omit',
      ...(body !== undefined ? { body } : {}),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof Error && e.name === 'AbortError') throw e;
    throw clientError('network_unavailable');
  }
  const data = await readBody(res);
  if (!res.ok) throw errorFromBody(res.status, data, res.headers.get('Retry-After'));
  return {
    status: res.status,
    data: data as T,
    etag: res.headers.get('ETag'),
    headers: res.headers,
  };
}
