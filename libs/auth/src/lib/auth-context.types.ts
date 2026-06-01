// Consumer types per API Contracts Phase 1 §1 — the three external surfaces
// the program serves. Closed enum.
export const CONSUMER_TYPES = ['recruiter', 'portal', 'ingestion'] as const;
export type ConsumerType = (typeof CONSUMER_TYPES)[number];

// Actor kinds per PR-8.0b directive §5 — the three principal kinds the JWT
// subject can represent. Closed enum; values mirror identity-audit
// ACTOR_TYPES. Missing or out-of-set claim → INVALID_TOKEN.
export const ACTOR_KINDS = ['system', 'service_account', 'user'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export interface AuthContext {
  // JWT subject — the authenticated principal (user id or service id).
  sub: string;
  consumer_type: ConsumerType;
  actor_kind: ActorKind;
  tenant_id: string;
  scopes: string[];
  iat: number;
  exp: number;
  // Optional site axis (PR-A1a Ruling 5): when present, the token is
  // scoped to a single site within the tenant; when absent, the token
  // is tenant-wide. Read by libs/authorization RolesGuard for routes
  // decorated with @RequireSiteMatch. AuthN behavior unchanged — the
  // claim is propagated verbatim, not validated against any catalog.
  site_id?: string;
}
