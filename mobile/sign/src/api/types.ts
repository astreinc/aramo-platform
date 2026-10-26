// Type helpers over the GENERATED OpenAPI types (src/api/generated/*). Screens name an
// OpenAPI path template + method and get the request/response types for free:
//
//   const env = await workspace.call('/v1/sign/sender/envelopes/{id}', 'get', { path: { id } });
//
import type { paths as SignPaths } from './generated/sign';
import type { paths as AuthPaths } from './generated/auth';

export type { SignPaths, AuthPaths };

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Sign paths reachable ONLY on the guest signing transport (M-A2 §2.1). */
export type GuestPath = Extract<keyof SignPaths, `/v1/sign/signing/${string}`>;
/** Sign paths reachable on the workspace (Bearer) transport. */
export type WorkspacePath = Exclude<keyof SignPaths, GuestPath>;

export type Operation<P extends keyof SignPaths, M extends HttpMethod> = NonNullable<
  SignPaths[P][M]
>;

type JsonContent<R> = R extends { content: { 'application/json': infer J } } ? J : undefined;

/** The JSON body of the operation's 2xx response (undefined for 204). */
export type SuccessJson<Op> = Op extends { responses: infer R }
  ? JsonContent<R[Extract<keyof R, 200 | 201 | 202 | 204>]>
  : never;

type BodyOf<Op> = Op extends { requestBody?: infer R } ? NonNullable<R> : never;
type JsonBodyOf<Op> = BodyOf<Op> extends { content: { 'application/json': infer B } } ? B : never;

/** The JSON request body; `undefined` when the operation takes none (`| undefined` if optional). */
export type RequestJson<Op> = [JsonBodyOf<Op>] extends [never]
  ? undefined
  : Op extends { requestBody: unknown }
    ? JsonBodyOf<Op>
    : JsonBodyOf<Op> | undefined;

export type PathParams<Op> = Op extends { parameters: { path: infer PP } }
  ? PP extends Record<string, unknown>
    ? PP
    : never
  : never;
export type QueryParams<Op> = Op extends { parameters: { query?: infer Q } }
  ? Q extends Record<string, unknown>
    ? Q
    : never
  : never;

export type QueryValue = string | number | boolean | null | undefined;

/** Options accepted by the typed `call()` helpers. Keys appear only when the op uses them. */
export type CallOptions<Op> = (PathParams<Op> extends never
  ? { path?: never }
  : { path: PathParams<Op> }) &
  (QueryParams<Op> extends never ? { query?: never } : { query?: QueryParams<Op> }) &
  ([RequestJson<Op>] extends [undefined]
    ? { body?: never }
    : undefined extends RequestJson<Op>
      ? { body?: Exclude<RequestJson<Op>, undefined> }
      : { body: RequestJson<Op> });

/** Substitute `{name}` segments; every value is URI-encoded. */
export function fillPath(
  template: string,
  params: Readonly<Record<string, unknown>> | undefined,
): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, name: string) => {
    const v = params?.[name];
    if (v === undefined || v === null || v === '')
      throw new Error(`missing path parameter ${name}`);
    return encodeURIComponent(String(v));
  });
}
