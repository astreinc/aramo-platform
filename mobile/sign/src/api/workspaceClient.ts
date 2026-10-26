// WORKSPACE transport: the signed-in user's Sign APIs (directive §3.6).
//   - `Authorization: Bearer <access JWT>` + `X-Aramo-Consumer: sign` on every request;
//   - one silent refresh + retry on 401, then "session expired" (back to Sign-in);
//   - If-Match (M-A3 §6) and Idempotency-Key (M-A3 §7/§8) helpers.
// It REFUSES the guest signing paths: a signing capability token never travels with
// workspace credentials (M-A2 §2.1). See guestSigningClient.ts for the other side.
import { ApiError, clientError } from './errors';
import { execute, type FetchFn, type HttpRequest, type HttpResponse } from './http';
import {
  fillPath,
  type CallOptions,
  type HttpMethod,
  type Operation,
  type QueryValue,
  type SuccessJson,
  type WorkspacePath,
} from './types';
import { randomId } from '../util/ids';

export const CONSUMER_HEADER = 'X-Aramo-Consumer';
export const CONSUMER = 'sign';
const GUEST_PREFIX = '/v1/sign/signing/';

export interface WorkspaceSessionPort {
  /** A current access token (refreshed ahead of expiry), or null when signed out. */
  getAccessToken(): Promise<string | null>;
  /** Rotate the refresh token now (single-flight). Null means the session is over. */
  refreshAccessToken(): Promise<string | null>;
  /** The session can't continue: the app returns to Sign-in, keeping the deep-link target. */
  sessionExpired(): void;
}

export interface EnvelopeVersion {
  readonly id: string;
  readonly revision: number;
}

export interface WorkspaceRequest {
  readonly method: HttpRequest['method'];
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>> | undefined;
  readonly body?: unknown;
  /** Required by the server on native draft writes, send and void (428 when missing). */
  readonly ifMatch?: string | EnvelopeVersion | undefined;
  /** Use one key per user intent and REUSE it on retry (remind, document upload). */
  readonly idempotencyKey?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface WorkspaceClient {
  request<T>(req: WorkspaceRequest): Promise<HttpResponse<T>>;
  call<P extends WorkspacePath, M extends HttpMethod & keyof Operations<P>>(
    path: P,
    method: M,
    options: CallOptions<Operation<P, M>> & WorkspaceCallExtras,
  ): Promise<SuccessJson<Operation<P, M>>>;
  callWithMeta<P extends WorkspacePath, M extends HttpMethod & keyof Operations<P>>(
    path: P,
    method: M,
    options: CallOptions<Operation<P, M>> & WorkspaceCallExtras,
  ): Promise<HttpResponse<SuccessJson<Operation<P, M>>>>;
}

type Operations<P extends WorkspacePath> = {
  [M in HttpMethod as Operation<P, M> extends never ? never : M]: true;
};

export interface WorkspaceCallExtras {
  readonly ifMatch?: string | EnvelopeVersion;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

/** The strong ETag the server sends for an envelope: `"{id}.{revision}"` (M-A3 §6). */
export function etagFor(version: EnvelopeVersion): string {
  return `"${version.id}.${version.revision}"`;
}

export function parseEtag(etag: string | null | undefined): EnvelopeVersion | null {
  const m = /^(?:W\/)?"([^".]+)\.(\d+)"$/.exec(etag ?? '');
  return m && m[1] && m[2] ? { id: m[1], revision: Number(m[2]) } : null;
}

/** A fresh Idempotency-Key. Create it once per user action and keep it for retries. */
export function newIdempotencyKey(): string {
  return randomId();
}

export function createWorkspaceClient(deps: {
  readonly baseUrl: string;
  readonly fetch: FetchFn;
  readonly session: WorkspaceSessionPort;
}): WorkspaceClient {
  const { baseUrl, fetch: fetchFn, session } = deps;

  function headersFor(accessToken: string, req: WorkspaceRequest): Record<string, string> {
    // Built fresh per request: only these headers, nothing inherited.
    const h: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      [CONSUMER_HEADER]: CONSUMER,
    };
    if (req.ifMatch !== undefined)
      h['If-Match'] = typeof req.ifMatch === 'string' ? req.ifMatch : etagFor(req.ifMatch);
    if (req.idempotencyKey !== undefined) {
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(req.idempotencyKey))
        throw new Error('invalid Idempotency-Key');
      h['Idempotency-Key'] = req.idempotencyKey;
    }
    return h;
  }

  async function request<T>(req: WorkspaceRequest): Promise<HttpResponse<T>> {
    if (req.path.startsWith(GUEST_PREFIX)) {
      throw new Error('guest signing paths are not reachable on the workspace transport');
    }
    const token = await session.getAccessToken();
    if (!token) {
      session.sessionExpired();
      throw clientError('session_expired', 401);
    }
    const send = (t: string) =>
      execute<T>(fetchFn, baseUrl, {
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.body,
        signal: req.signal,
        headers: headersFor(t, req),
      });
    try {
      return await send(token);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
    }
    // 401: the access token was rejected. Rotate once and retry once.
    const fresh = await session.refreshAccessToken();
    if (!fresh) {
      session.sessionExpired();
      throw clientError('session_expired', 401);
    }
    try {
      return await send(fresh);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        session.sessionExpired();
        throw clientError('session_expired', 401);
      }
      throw e;
    }
  }

  function toRequest(
    path: string,
    method: HttpMethod,
    options: Record<string, unknown>,
  ): WorkspaceRequest {
    return {
      method: method.toUpperCase() as WorkspaceRequest['method'],
      path: fillPath(path, options['path'] as Record<string, unknown> | undefined),
      query: options['query'] as Record<string, QueryValue> | undefined,
      body: options['body'],
      ifMatch: options['ifMatch'] as WorkspaceRequest['ifMatch'],
      idempotencyKey: options['idempotencyKey'] as string | undefined,
      signal: options['signal'] as AbortSignal | undefined,
    };
  }

  return {
    request,
    async call(path, method, options) {
      const res = await request<never>(toRequest(path, method, options as Record<string, unknown>));
      return res.data;
    },
    callWithMeta(path, method, options) {
      return request(toRequest(path, method, options as Record<string, unknown>));
    },
  };
}
