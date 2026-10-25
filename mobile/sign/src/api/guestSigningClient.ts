// GUEST signing transport (M-A2 §2.1): `/v1/sign/signing/*` authorized ONLY by a
// signing capability token in the request body — from an emailed /s/ or /d/ link, or
// minted by POST /v1/sign/inbox/:id/sign for a claimed recipient (M-A2 §2.2).
//
//   - NEVER sends Authorization or X-Aramo-Consumer, and never reads the session;
//   - the token lives in this object's memory only (never persisted, logged or retried);
//   - a revoked / expired / replaced token ENDS the session: the token is discarded and
//     every later call fails locally with `signing_session_ended` (M-A2 §2.3, C-21).
import { ApiError, clientError } from './errors';
import { execute, type FetchFn } from './http';
import type { GuestPath, Operation, RequestJson, SuccessJson } from './types';

const GUEST_PREFIX = '/v1/sign/signing/';

/** Refusals after which a signing token must never be used again. */
const TOKEN_ENDING_REASONS = new Set<string>([
  'SIGNING_SESSION_INVALID',
  'SIGNING_SESSION_EXPIRED',
  'session_revoked',
  'link_expired',
]);

export function endsSigningSession(e: ApiError): boolean {
  return e.status === 401 || TOKEN_ENDING_REASONS.has(e.reason) || TOKEN_ENDING_REASONS.has(e.code);
}

type GuestBody<P extends GuestPath> = Omit<NonNullable<RequestJson<Operation<P, 'post'>>>, 'token'>;

export interface GuestSigningSession {
  readonly active: boolean;
  /** POST a signing operation; the token is added to the body here and nowhere else. */
  post<P extends GuestPath>(
    path: P,
    body?: GuestBody<P>,
  ): Promise<SuccessJson<Operation<P, 'post'>>>;
  /** Untyped escape hatch for signing operations not yet in openapi/sign.yaml (B-12). */
  postRaw<T>(path: `${typeof GUEST_PREFIX}${string}`, body?: Record<string, unknown>): Promise<T>;
  /** Forget the token now (signing task finished, screen left, or link ended). */
  discard(): void;
}

export interface GuestSigningClient {
  open(token: string): GuestSigningSession;
}

export function createGuestSigningClient(deps: {
  readonly baseUrl: string;
  readonly fetch: FetchFn;
}): GuestSigningClient {
  const { baseUrl, fetch: fetchFn } = deps;
  return {
    open(initial: string): GuestSigningSession {
      let token: string | null = initial;
      async function send<T>(path: string, body: Record<string, unknown> | undefined): Promise<T> {
        if (!path.startsWith(GUEST_PREFIX))
          throw new Error('only signing paths are reachable on the guest transport');
        if (token === null) throw clientError('signing_session_ended');
        try {
          const res = await execute<T>(fetchFn, baseUrl, {
            method: 'POST',
            path,
            body: { ...(body ?? {}), token },
            // Deliberately empty: no Authorization, no consumer header, no cookies.
            headers: {},
          });
          return res.data;
        } catch (e) {
          if (e instanceof ApiError && endsSigningSession(e)) token = null;
          throw e;
        }
      }
      return {
        get active() {
          return token !== null;
        },
        post(path, body) {
          return send(path, body as Record<string, unknown> | undefined);
        },
        postRaw(path, body) {
          return send(path, body);
        },
        discard() {
          token = null;
        },
      };
    },
  };
}
