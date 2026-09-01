// HF-AUTH-1 — the authorization scope-snapshot cache PORT.
//
// The cache stores the RESOLVED effective scope set for a principal, keyed by the
// authorization version it was resolved at (`authz:{tenant}:{principal}:{version}`).
// A given version's scope set is IMMUTABLE — any change to a principal's effective
// scopes bumps the version, so a version key never has to be invalidated; the new
// version simply uses a new key. Redis is a PERFORMANCE cache only; Postgres RBAC
// (+ the AuthorizationVersion table) is the authority.
//
// Failure model (fail-closed is enforced by the RESOLVER, not here):
//   - `get` returns null on a genuine MISS.
//   - `get`/`set` THROW when the cache backend is UNREACHABLE. The resolver
//     distinguishes the two: a miss → resolve from canonical RBAC + populate; an
//     unreachable cache → resolve from canonical RBAC WITHOUT caching (still proves
//     authorization). Only when the canonical store is ALSO unreachable does the
//     resolver return `unresolvable` (deny). The cache is never allowed to expand
//     privilege.
export const AUTHORIZATION_SCOPE_CACHE = 'AUTHORIZATION_SCOPE_CACHE' as const;

export interface AuthorizationScopeCache {
  // Returns the cached scope set for `key`, or null on a miss. Throws if the cache
  // backend is unreachable.
  get(key: string): Promise<string[] | null>;
  // Stores `scopes` under `key` with a bounded TTL. Throws if unreachable. A
  // version key is immutable, so overwrite races are harmless.
  set(key: string, scopes: string[], ttlSeconds: number): Promise<void>;
}
