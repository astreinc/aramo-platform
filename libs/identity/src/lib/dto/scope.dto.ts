// Seed scope catalog (directive §6, initial catalog).
// Format <domain>:<action>; matches regex
// /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_:-]*$/ per §9 test 18.
// Adding a scope key requires a directive amendment.
//
// PR-A1a Ruling 2 / Ruling 3 expansion (2026-06-01): adds a minimal
// representative set of ATS + Portal scopes proving the catalog
// expansion mechanism. The full 36-scope ATS/Portal catalog from the
// Gate-5 prompt §5 is deferred to PR-A1a-2 (PL-62 split per Ruling 7);
// the 7 scopes added here exercise (a) the recruiter→submittal:create
// /:approve enforcement proof for §6, (b) the tenant_admin-only
// requisition:read:all divergence from the OpenCATS floor, and
// (c) the candidate-role portal:profile / portal:consent surface.
// PR-A1a-2 expansion (2026-06-01) extends the catalog with the full ATS
// scope surface per directive §3.1. Ruling 1 uniform divergence: every
// `:delete` (destructive) and every `:read:all` (see-all) is reserved to
// `tenant_admin`. Recruiter keeps the full operational workflow —
// `:create` / `:edit` / `talent:search` / `pipeline:add|change-status|
// add-activity` / `calendar:event-create|edit` / assigned `:read`.
// Viewer is read-only on the domain entities recruiter can see (+ search +
// examination/activity reads).
//
// Note: `submittal:read` + the engagement-domain scopes are NOT in this
// catalog; their bare routes (GET /v1/submittals/:id, all 7 engagement
// routes) remain unguarded at A1a-2 and are deferred to a follow-on PR.
export const SEED_SCOPE_KEYS = [
  // Existing pre-A1a catalog
  'consent:read',
  'consent:write',
  'consent:decision-log:read',
  'auth:session:read',
  'identity:user:read',
  'identity:tenant:read',
  // PR-A1a ATS subset (3)
  'requisition:read',           // assigned-to-me (default recruiter); see :all below
  'requisition:read:all',       // see-all (tenant_admin only — Aramo divergence from OpenCATS coarse EDIT/DELETE tier)
  'submittal:create',           // recruiter
  'submittal:approve',          // recruiter
  // PR-A1a Portal subset (4) — for the `candidate` role
  'portal:profile:read',
  'portal:profile:edit',
  'portal:consent:read',
  'portal:consent:write',
  // PR-A1a-2 ATS expansion (27 scopes; Ruling 1 uniform divergence).
  // talent domain (5)
  'talent:read',                // recruiter+ (assigned)
  'talent:create',              // recruiter+
  'talent:edit',                // recruiter+
  'talent:delete',              // tenant_admin only (Ruling 1 destructive)
  'talent:search',              // recruiter+ (Constrained Talent Access per A1a audit)
  // company domain (4)
  'company:read',               // recruiter+
  'company:create',             // recruiter+
  'company:edit',               // recruiter+
  'company:delete',             // tenant_admin only
  // contact domain (4)
  'contact:read',               // recruiter+
  'contact:create',             // recruiter+
  'contact:edit',               // recruiter+
  'contact:delete',             // tenant_admin only
  // pipeline domain (4)
  'pipeline:add',               // recruiter+
  'pipeline:change-status',     // recruiter+
  'pipeline:add-activity',      // recruiter+
  'pipeline:remove',            // tenant_admin only (Ruling 1 destructive: removing a candidate from a pipeline)
  // calendar domain (3)
  'calendar:event-create',      // recruiter+
  'calendar:event-edit',        // recruiter+ (own events)
  'calendar:event-delete',      // tenant_admin only
  // activity + examination + requisition (5)
  'activity:read',              // viewer+
  'examination:read',           // viewer+ (read-only Core output)
  'requisition:create',         // recruiter+
  'requisition:edit',           // recruiter+
  'requisition:delete',         // tenant_admin only
  // tenant admin (2)
  'tenant:admin:user-manage',   // tenant_admin only
  'tenant:admin:settings',      // tenant_admin only
  // HK-IDENT-SCOPES — 6 deferred ATS scopes (retires A3/A4/A5a gap bundle).
  // attachment:delete is recruiter+ via a BOUNDED Ruling 1 carve-out
  // (detach is a junction/link delete, NOT entity destruction).
  'requisition:assign',         // tenant_admin only (assignment is an admin act)
  'attachment:read',            // recruiter+
  'attachment:create',          // recruiter+
  'attachment:delete',          // recruiter+ (Ruling 1 carve-out — junction/link delete)
  'pipeline:read',              // recruiter+
  'activity:create',            // recruiter+
  // AUTHZ-2 — platform-tier scopes (a SEPARATE namespace from the 47 tenant
  // scopes above; Lead ruling 5 — the 3-scope minimum set). The bundle is
  // assigned only to the platform `super_admin` role; no tenant role holds
  // any platform:* scope, and no platform role holds any tenant scope. The
  // DDR §13.1 tripwire is enforced by namespace partition + the consumer_type
  // check at the guard layer. Deferrals (gap-and-noted to later platform
  // PRs): platform:tenant:deactivate, platform:tenant:entitlement:edit,
  // platform:billing:*, platform:audit:read.
  'platform:tenant:provision',  // super_admin only — create tenant + entitlement seed + Tenant-Owner invite
  'platform:tenant:read',       // super_admin only — list/read tenants for the platform view
  'platform:admin:invite',      // super_admin only — invite another platform admin (against the platform Cognito pool)
] as const;
export type SeedScopeKey = (typeof SEED_SCOPE_KEYS)[number];

// AUTHZ-2 — the platform-namespace scope subset, used by tests + the
// EntitlementGuard / RolesGuard separation proofs to assert that no tenant
// role bundle contains any of these and no platform role bundle contains
// anything outside this subset.
export const PLATFORM_SCOPE_KEYS = [
  'platform:tenant:provision',
  'platform:tenant:read',
  'platform:admin:invite',
] as const;
export type PlatformScopeKey = (typeof PLATFORM_SCOPE_KEYS)[number];

// Scope-key format regex (directive §9 test 18). Authoritative reference
// for both validation and tests.
export const SCOPE_KEY_FORMAT = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_:-]*$/;

// ScopeDto — public shape of the Scope entity.
export interface ScopeDto {
  id: string;
  key: string;
  description: string | null;
  created_at: string;
}
