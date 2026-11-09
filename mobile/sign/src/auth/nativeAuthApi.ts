// auth-service native endpoints (M-A1 §3.3-§3.5; contract in the shared brief):
//   POST /auth/native/sign/token    {code, code_verifier, redirect_uri, nonce, device}
//   POST /auth/native/sign/refresh  {refresh_token}         -> rotated pair
//   POST /auth/native/sign/logout   {refresh_token}         -> 204
//   POST /auth/link/email/start     {link_handle, email?}   -> 202 (A1 L-4 proof (b))
//   POST /auth/link/email/verify    {link_handle, code}     -> {linked, idp}
// Tokens come back in the BODY (never cookies). These calls carry no Authorization.
import type {
  LinkEmailStartRequest,
  LinkEmailVerifyRequest,
  LinkedResponse,
  NativeTokenLinkFields,
  NativeTokenLinkResult,
} from '../api/apple-contract-types';
import { isProvider } from './authorize';
import type { components } from '../api/generated/auth';
import { clientError } from '../api/errors';
import { execute, type FetchFn } from '../api/http';

/** Generated from openapi/auth.yaml (NativeTokenResponse / NativeTokenRequest). */
export type NativeTokenResponse = components['schemas']['NativeTokenResponse'] &
  NativeTokenLinkResult;
/** A1 L-4: the token body optionally carries a pending-link handle (proof (a)). */
export type CodeExchange = components['schemas']['NativeTokenRequest'] & NativeTokenLinkFields;

export interface NativeAuthApi {
  exchangeCode(body: CodeExchange): Promise<NativeTokenResponse>;
  refresh(refreshToken: string): Promise<NativeTokenResponse>;
  logout(refreshToken: string): Promise<void>;
  /** A1 L-4 proof (b): always 202, whether or not the account exists. */
  linkEmailStart(body: LinkEmailStartRequest): Promise<void>;
  linkEmailVerify(body: LinkEmailVerifyRequest): Promise<LinkedResponse>;
}

/** A `{linked: true, idp}` answer, or a 502 client error for anything else. */
export function validatedLinked(data: unknown): LinkedResponse {
  const d = (data ?? {}) as { linked?: unknown; idp?: unknown };
  if (d.linked !== true || !isProvider(d.idp)) throw clientError('invalid_grant', 502);
  return { linked: true, idp: d.idp };
}

function validated(data: unknown): NativeTokenResponse {
  const d = (data ?? {}) as Partial<NativeTokenResponse>;
  if (
    typeof d.access_token !== 'string' ||
    !d.access_token ||
    typeof d.refresh_token !== 'string' ||
    !d.refresh_token ||
    typeof d.expires_in !== 'number' ||
    d.token_type !== 'Bearer'
  ) {
    throw clientError('invalid_grant', 502);
  }
  return {
    access_token: d.access_token,
    refresh_token: d.refresh_token,
    expires_in: d.expires_in,
    token_type: 'Bearer',
    device_session_id: typeof d.device_session_id === 'string' ? d.device_session_id : '',
    ...(typeof d.link_refused === 'string' && d.link_refused
      ? { link_refused: d.link_refused }
      : {}),
  };
}

export function createNativeAuthApi(deps: {
  readonly baseUrl: string;
  readonly fetch: FetchFn;
}): NativeAuthApi {
  const post = (path: string, body: unknown) =>
    execute<unknown>(deps.fetch, deps.baseUrl, { method: 'POST', path, body, headers: {} });
  return {
    async exchangeCode(body) {
      return validated((await post('/auth/native/sign/token', body)).data);
    },
    async refresh(refreshToken) {
      return validated(
        (await post('/auth/native/sign/refresh', { refresh_token: refreshToken })).data,
      );
    },
    async logout(refreshToken) {
      await post('/auth/native/sign/logout', { refresh_token: refreshToken });
    },
    async linkEmailStart(body) {
      await post('/auth/link/email/start', body);
    },
    async linkEmailVerify(body) {
      return validatedLinked((await post('/auth/link/email/verify', body)).data);
    },
  };
}
