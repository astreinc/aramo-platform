// Apple Go-Live Amendment A1 (LOCKED) — Proven Account Linking. Auth's OWN port
// for the identity-side linking store (ADR-0021 §2: auth defines the ports; the
// Aramo adapter in apps/auth-service implements it over @aramo/identity). Auth
// never learns what a user, a tenant kind or a pin is: it asks "record this
// denied identity", "attach this identity to this proven principal", and so on,
// and maps the closed reasons it gets back to HTTP.

export const ACCOUNT_LINK_DIRECTORY = 'ACCOUNT_LINK_DIRECTORY';

export type AccountLinkProof = 'existing_provider' | 'email_code' | 'signed_in';

// The denied (or newly authenticated) federated identity.
export interface AccountLinkIdentity {
  provider: string;
  provider_subject: string;
  // The Aramo provider value ('google' | 'microsoft' | 'apple'); anything else is
  // refused by the adapter.
  idp: string | null;
  // The IdP-verified email at this sign-in.
  verified_email: string;
}

// L-5 refusal reasons: identity_already_linked · idp_already_linked ·
// idp_not_permitted_for_tenant · user_inactive · link_expired.
export type AccountLinkAttachResult =
  | { ok: true; idp: string; account_email: string }
  | { ok: false; reason: string };

export type AccountLinkVerifyResult =
  | AccountLinkAttachResult
  | { ok: false; reason: 'code_invalid'; attempts_remaining: number };

export interface AccountLinkMethod {
  idp: string;
  email_snapshot: string | null;
  linked_at: string;
}

export type AccountLinkRemoveResult =
  | { ok: true; idp: string; account_email: string }
  | { ok: false; reason: 'last_sign_in_method' | 'sign_in_method_not_found' };

export interface AccountLinkDirectory {
  /**
   * L-2 — record a denied sign-in's identity. `reason` is the denial
   * (user_not_provisioned | idp_identity_conflict). Returns the one-time handle,
   * or null when no pending link applies (unknown provider, ...).
   */
  createPendingLink(input: AccountLinkIdentity & { reason: string }): Promise<{ handle: string; idp: string } | null>;
  /** Proof (a) — consume `handle` and attach its identity to the signed-in principal. */
  attachPendingLink(input: { handle: string; principal_id: string }): Promise<AccountLinkAttachResult>;
  /** Proof (c) — attach a freshly authenticated identity to the signed-in principal. */
  attachIdentity(input: AccountLinkIdentity & { principal_id: string; proof: AccountLinkProof }): Promise<AccountLinkAttachResult>;
  /** Proof (b) start — the code to send and where, or null (nothing is sent). */
  startEmailProof(input: { handle: string; email: string | null }): Promise<{ to: string; code: string; idp: string } | null>;
  /** Proof (b) verify — attaches on success. */
  verifyEmailProof(input: { handle: string; code: unknown }): Promise<AccountLinkVerifyResult>;
  listSignInMethods(principal_id: string): Promise<AccountLinkMethod[]>;
  removeSignInMethod(input: { principal_id: string; idp: string }): Promise<AccountLinkRemoveResult>;
}
