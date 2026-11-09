// HAND-WRITTEN, TEMPORARY: the Apple Go-Live (v1.0 + A1) request and response shapes that
// the checked-in generated files (src/api/generated/*.ts) do not carry yet. The backend
// workstreams update openapi/auth.yaml, sign.yaml and platform.yaml in the same PR; when
// `npm run generate:api` is re-run against them, these aliases are replaced by the
// generated types and this file is deleted. Shapes follow the build contract field for
// field. Nothing here is policy: the screens render what the server decided.

/** Aramo's federated provider values (Apple Go-Live R-1: `apple` ↔ Cognito `SignInWithApple`). */
export type FederatedIdp = 'google' | 'microsoft' | 'apple';

// ── Native token (A1 L-4 proof (a)) ──────────────────────────────────────────

/** POST /auth/native/sign/token gains an optional pending-link handle. */
export interface NativeTokenLinkFields {
  readonly link_handle?: string;
}

/** The token response gains `link_refused` when the attach was refused but sign-in succeeded. */
export interface NativeTokenLinkResult {
  readonly link_refused?: string;
}

/** 403 user_not_provisioned / idp_identity_conflict `error.details` (A1 L-2). */
export interface PendingLinkDetails {
  readonly reason: 'user_not_provisioned' | 'idp_identity_conflict';
  /** Present only when a pending link was created. Memory only, never stored. */
  readonly link_handle?: string;
  readonly idp?: FederatedIdp;
}

// ── Linking (A1 L-4) ─────────────────────────────────────────────────────────

/** 200 of POST /auth/native/sign/link and POST /auth/link/email/verify. */
export interface LinkedResponse {
  readonly linked: true;
  readonly idp: FederatedIdp;
}

/** POST /auth/link/email/start (always 202 `{}`). */
export interface LinkEmailStartRequest {
  readonly link_handle: string;
  readonly email?: string;
}

/** POST /auth/link/email/verify. */
export interface LinkEmailVerifyRequest {
  readonly link_handle: string;
  readonly code: string;
}

/** One row of GET /auth/me/sign-in-methods?consumer=… */
export interface SignInMethod {
  readonly idp: FederatedIdp;
  readonly email_snapshot: string | null;
  readonly linked_at: string;
}

export interface SignInMethodsResponse {
  readonly items: readonly SignInMethod[];
}

// ── Personal signup (Apple Go-Live W2 / R-9) ─────────────────────────────────

export type PersonalSignupClient = 'web' | 'android' | 'ios';

/** `complete` → `sign_in` gains `apple` (the login URL with idp=apple). */
export interface PersonalSignupSignInLinks {
  readonly google: string;
  readonly apple?: string;
}

// ── Deletion revocation (Apple Go-Live R-8) ──────────────────────────────────

/** POST /v1/sign/me/apple/revoke → 202 `{}` always (best effort). */
export interface AppleRevokeRequest {
  readonly authorization_code: string;
  readonly client: 'ios' | 'web';
}
