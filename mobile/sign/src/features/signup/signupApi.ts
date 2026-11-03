// Native Personal signup transport (M-A11 §2, §4): the session-less platform-admin routes
// under /v1/signup/sign/personal/*, reached through the Sign host like the rest of the app.
// Unauthenticated, like auth/nativeAuthApi.ts: no Authorization header, no consumer header
// and no cookies (execute() always sends credentials: 'omit'). Every route answers 404
// while SIGN_PERSONAL_SIGNUP_MODE is `off`.
//
// Types come from openapi/platform.yaml (generated: src/api/generated/platform-signup.ts,
// the signup paths only); the start body is narrowed to what the app sends (client android).
import type { components, operations } from '../../api/generated/platform-signup';
import { execute, type FetchFn } from '../../api/http';
import type { NextStep } from './signupModel';

export const PERSONAL_SIGNUP_PATH = '/v1/signup/sign/personal';

/** One effective Personal document from GET …/terms. */
export type TermsListDocument = components['schemas']['PersonalTermsDocument'];

/** GET …/terms/{key}/{version}: the bound text of one effective Personal document. */
export type TermsText = components['schemas']['PersonalTermsText'];

type StartRequest = operations['startPersonalSignup']['requestBody']['content']['application/json'];

/** POST …/start with client "android" (contract: robot_token absent; integrity_token instead). */
export interface NativeStartBody {
  readonly client: 'android';
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly residence: 'US' | 'IN';
  readonly invite_code: string | null;
  readonly hp: '';
  readonly elapsed_ms: number;
}

export interface AcceptEntry {
  readonly key: string;
  readonly version: string;
  readonly sha256: string;
}

export type CompleteResponse =
  operations['completePersonalSignup']['responses'][200]['content']['application/json'];

export interface SignupApi {
  /** `{off: true}` = 404 (mode off); `documents: null` = not every document is approved. */
  listTerms(): Promise<{ off: true } | { off: false; documents: TermsListDocument[] | null }>;
  termsText(key: string, version: string): Promise<TermsText>;
  start(
    body: NativeStartBody & { readonly integrity_token: string },
  ): Promise<{ signup_id: string }>;
  resendEmail(signupId: string): Promise<void>;
  verifyEmail(signupId: string, code: string): Promise<NextStep>;
  sendPhoneCode(signupId: string): Promise<boolean>;
  verifyPhone(signupId: string, code: string): Promise<NextStep>;
  complete(signupId: string, accept: readonly AcceptEntry[]): Promise<CompleteResponse>;
}

const NEXT: readonly NextStep[] = ['phone', 'terms', 'review'];

export function createSignupApi(deps: {
  readonly baseUrl: string;
  readonly fetch: FetchFn;
  /** Recorded with the legal acceptance (M-A11 §2: "the app user agent"). */
  readonly userAgent?: string;
}): SignupApi {
  const headers: Record<string, string> = deps.userAgent ? { 'User-Agent': deps.userAgent } : {};
  const post = async <T>(path: string, body: unknown): Promise<T> =>
    (
      await execute<T>(deps.fetch, deps.baseUrl, {
        method: 'POST',
        path: `${PERSONAL_SIGNUP_PATH}/${path}`,
        body,
        headers,
      })
    ).data;
  const get = async <T>(path: string): Promise<T> =>
    (await execute<T>(deps.fetch, deps.baseUrl, { method: 'GET', path, headers })).data;

  return {
    async listTerms() {
      try {
        const j = (await get<{ documents?: TermsListDocument[] | null }>(
          `${PERSONAL_SIGNUP_PATH}/terms`,
        )) ?? { documents: null };
        const docs = Array.isArray(j.documents) && j.documents.length > 0 ? j.documents : null;
        return { off: false, documents: docs };
      } catch (e) {
        if ((e as { status?: number }).status === 404) return { off: true };
        throw e;
      }
    },
    termsText: (key, version) =>
      get<TermsText>(
        `${PERSONAL_SIGNUP_PATH}/terms/${encodeURIComponent(key)}/${encodeURIComponent(version)}`,
      ),
    // `satisfies`: the app's narrowed body stays a valid generated request body.
    start: (body) => post<{ signup_id: string }>('start', body satisfies StartRequest),
    async resendEmail(signupId) {
      await post<unknown>('resend-email', { signup_id: signupId });
    },
    async verifyEmail(signupId, code) {
      const r = await post<{ next?: string }>('verify-email', { signup_id: signupId, code });
      return NEXT.includes(r?.next as NextStep) ? (r.next as NextStep) : 'terms';
    },
    async sendPhoneCode(signupId) {
      const r = await post<{ sent?: boolean }>('phone/send', { signup_id: signupId });
      return r?.sent === true;
    },
    async verifyPhone(signupId, code) {
      const r = await post<{ next?: string }>('phone/verify', { signup_id: signupId, code });
      return r?.next === 'review' ? 'review' : 'terms';
    },
    complete: (signupId, accept) =>
      // The backend does not store the client at start: it is passed again here (M-A11 §2.2).
      post<CompleteResponse>('complete', {
        signup_id: signupId,
        client: 'android',
        accept: accept.map((a) => ({ key: a.key, version: a.version, sha256: a.sha256 })),
      }),
  };
}
