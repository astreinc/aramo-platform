// PLATFORM-UX-1 B-1a (directive R-6) — GET /platform/me, the signed-in platform
// operator's own identity for the console's environment bar and account menu.
// Caller-only: user_id is the token `sub` and tenant_id the token `tenant_id`
// (never a path/query/body value), so no other principal is readable here.
// role_keys are the caller's ACTIVE role keys in that tenant, sorted.
export interface PlatformMeResponseDto {
  user_id: string;
  email: string;
  display_name: string | null;
  tenant_id: string;
  tenant_name: string;
  role_keys: string[];
}
