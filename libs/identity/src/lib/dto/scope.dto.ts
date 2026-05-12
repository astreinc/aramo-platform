// Seed scope catalog (directive §6, initial catalog).
// Format <domain>:<action>; matches regex
// /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_:-]*$/ per §9 test 18.
// Adding a scope key requires a directive amendment.
export const SEED_SCOPE_KEYS = [
  'consent:read',
  'consent:write',
  'consent:decision-log:read',
  'auth:session:read',
  'identity:user:read',
  'identity:tenant:read',
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
