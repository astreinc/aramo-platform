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
] as const;
export type SeedScopeKey = (typeof SEED_SCOPE_KEYS)[number];

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
