// Consumer types per API Contracts Phase 1 §1 — the external surfaces the
// program serves. Closed enum.
//
// AUTHZ-2 (DDR D1/D3 + Lead ruling 3): `platform` is the 4th consumer_type,
// for the platform-tier surface (apps/platform-admin). The platform tier
// authenticates via the SAME /auth/{consumer} pipeline (PKCE/JWKS/refresh
// reused — no second auth stack) but against a SEPARATE Cognito user pool
// (Lead ruling 4 — A1; the identity-store boundary IS the separation, not a
// code-level group check). The platform JWT carries tenant_id =
// PLATFORM_TENANT_SENTINEL and consumer_type='platform' + platform:* scopes;
// the DDR §13.1 tripwire is the consumer_type check at tenant guards (a
// platform token never satisfies a tenant guard; a tenant token never
// satisfies a platform guard).
export const CONSUMER_TYPES = ['recruiter', 'portal', 'ingestion', 'platform'] as const;
export type ConsumerType = (typeof CONSUMER_TYPES)[number];

// AUTHZ-2: the sentinel tenant_id stamped on every platform JWT. Backed by a
// seed-only identity.Tenant row (name='Aramo Platform'). The sentinel preserves
// the closed JWT contract (AuthContext.tenant_id stays required string) while
// keeping the platform-tier physically distinct: the DDR §13.1 tripwire fires
// at the consumer_type check, not at tenant_id presence. Apps/tenant routes
// MUST reject tokens whose consumer_type === 'platform' regardless of scopes.
export const PLATFORM_TENANT_SENTINEL_ID =
  '01900000-0000-7000-8000-000000000100' as const;

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
