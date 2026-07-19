// Auth-Decoupling PR-1 (ADR-0021 §3). Public surface for the host auth-profile
// registry. ISO-string timestamps; never raw Prisma rows (ADR-0001 service
// convention, mirrors RefreshTokenDto).

// Closed vocabulary of host classes — ONE row per class (R-A1-7). The registry
// resolves a request host to exactly one of these, or misses (→ legacy path).
// The seed and the classifier both anchor to this set; the seed-parity guard
// (§3.3) asserts every class the resolver can produce has a seeded row.
export const HOST_CLASSES = ['TENANT', 'PLATFORM', 'PORTAL'] as const;
export type HostClass = (typeof HOST_CLASSES)[number];

export interface HostAuthProfileDto {
  id: string;
  host_class: HostClass;
  host_pattern: string;
  // Cognito profile — inert in PR-1 (R-A1-5; no reader yet).
  pool_id: string;
  client_id: string;
  issuer: string;
  domain: string;
  // Class-default IdP hint; null = no hint. TENANT is overridden per-request.
  default_idp: string | null;
  post_login_path: string;
  signout_path: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}
