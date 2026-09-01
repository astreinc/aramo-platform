import type { ActorKind, ConsumerType } from './auth-context.types.js';

// HF-AUTH-1 — the app-layer authorization-resolution PORT.
//
// The compact access JWT carries NO `scopes[]` claim. It carries identity + a
// tenant/site context + an `authz_version` reference. The JWT guard and the
// auth-service cookie verifier hydrate `AuthContext.scopes` by calling this port,
// which is BOUND at each application's composition root to an identity-backed
// implementation (canonical RBAC = authority, Redis = versioned cache). Defining
// the port here keeps `libs/auth` infrastructure-light: it takes NO dependency on
// `libs/identity` — the JWT guard depends only on this interface, and the app root
// injects the concrete resolver (avoiding a `libs/auth → libs/identity` nx edge).
//
// SECURITY CONTRACT:
//   - `ok`          → the token's authz_version MATCHES the current authoritative
//                     version; `scopes` is the freshly-resolved effective set.
//   - `stale`       → the token's authz_version does NOT match current (a grant/
//                     membership/role change bumped it). The caller MUST reject
//                     with INVALID_TOKEN so the client re-authenticates/refreshes.
//                     This is the immediate-revocation lever.
//   - `unresolvable`→ authorization could not be PROVEN (canonical store
//                     unreachable and no trustworthy cache). The caller MUST fail
//                     closed (deny). NEVER trust the token's own claims or
//                     approximate scopes on this branch.
export const EFFECTIVE_AUTHORIZATION_RESOLVER = 'EFFECTIVE_AUTHORIZATION_RESOLVER' as const;

export interface EffectiveAuthorizationInput {
  tenant_id: string;
  // The principal the token authenticates (the JWT `sub`).
  principal_id: string;
  consumer_type: ConsumerType;
  actor_kind: ActorKind;
  // Site axis (PR-A1a): when present the effective set is the tenant-wide ∪
  // site-matched union; when absent, tenant-wide only (site authority never
  // leaks to a tenant-wide token).
  site_id?: string;
  // The authorization revision the token was minted at. Compared to the current
  // authoritative version; a mismatch yields `stale`.
  token_authz_version: number;
}

export type EffectiveAuthorizationResolution =
  | { status: 'ok'; scopes: string[] }
  | { status: 'stale' }
  | { status: 'unresolvable' };

export interface EffectiveAuthorizationResolver {
  resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution>;
}
