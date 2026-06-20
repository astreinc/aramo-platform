// Settings S5b — hand-mirrored types for the tenant user-management surface.
//
// Mirror source (NO @aramo/* import — ats-web stays a leaf consumer of the HTTP
// surface; the FE-isolation rule from S5a):
//   - TenantUserView: libs/identity/src/lib/identity.repository.ts
//
// Settings Rebuild D5 CLOSED the role-catalog hand-mirror drift: the role DATA
// (keys, descriptions, scope bundles) is no longer mirrored here — it is fetched
// from GET /v1/tenant/roles-catalog (the seed/DB is the single source). Only the
// TenantRoleCatalogEntry SHAPE remains, populated by users-api.fetchPickerRoles.

// ─── TenantUserView (S5-BE1 + S3a/S3b) ───────────────────────────────
//
// The roster-row shape returned by GET /v1/tenant/users (and the singular
// detail by GET /v1/tenant/users/:user_id). Note: `is_active` +
// `deactivated_at` are MEMBERSHIP-level (the S3a soft-disable columns),
// NOT User.is_active (the global flag). `role_keys` is sorted asc and
// includes only active roles.
export interface TenantUserView {
  readonly user_id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly is_active: boolean;
  readonly deactivated_at: string | null;
  readonly site_id: string | null;
  readonly role_keys: readonly string[];
}

export interface TenantUserListView {
  readonly items: readonly TenantUserView[];
}

// ─── The tenant-tier assignable role entry (the picker's row shape) ───
//
// Settings Rebuild D5: the catalog DATA now comes from the backend
// roles-catalog GET (the seed/DB is the single source); this interface is
// just the shape the RolePicker renders, populated by fetchRolesCatalog.
// `super_admin` (platform) is excluded server-side.
//
// `label` is the operator-facing role name (R10 vocab); `description` is the
// one-liner under the label; `helper` is a per-role note. `requiresSetting`
// ties the role to a settings-key precondition (Settings S4 gate for
// auditor_with_financials) — the picker proactively disables the option
// (ruling 4: try-read + graceful 403 fallback); the BE rejection is the floor.

export interface TenantRoleCatalogEntry {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly helper?: string;
  // Settings S4 — when present, the role's grant is gated by a tenant
  // KNOWN_SETTING that must be `true`. The picker uses this to
  // proactively disable the option (ruling 4).
  readonly requiresSetting?: {
    readonly key: 'audit.financials_enabled';
    readonly disabledMessage: string;
  };
}

// The catalog DATA is no longer hand-mirrored here (Settings Rebuild D5 closed
// the drift): it is fetched from GET /v1/tenant/roles-catalog (the seed/DB is
// the single source) and mapped to TenantRoleCatalogEntry[] in users-api
// (fetchRolesCatalog). The RolePicker takes the roles as a prop.

// ─── API payload shapes ──────────────────────────────────────────────

export interface InviteRequest {
  email: string;
  display_name: string | null;
  role_keys: readonly string[];
}

export interface InviteResponse {
  user_id: string;
  membership_id: string;
  cognito_sub: string;
}

export interface DisableResponse {
  membership_id: string;
  changed: boolean;
  already_disabled: boolean;
}

export interface AssignRolesRequest {
  role_keys: readonly string[];
}

export interface AssignRolesResponse {
  membership_id: string;
  before_role_keys: readonly string[];
  after_role_keys: readonly string[];
  added_role_keys: readonly string[];
  removed_role_keys: readonly string[];
}

// ─── D5 rejection details (the load-bearing surface) ──────────────────
//
// The backend role-bundle-validator surfaces VALIDATION_ERROR with
// `details = { reason: 'invertible_role_union', role_keys, cause }`.
// We type only the fields the FE is allowed to RENDER (role_keys + the
// reason itself). `cause` is intentionally NOT typed — it names internal
// scope keys and MUST NEVER be rendered (the §6/R10 line; the
// bundle-naming template uses role_keys only — ruling 3).
export interface D5InvertibleUnionDetails {
  reason: 'invertible_role_union';
  role_keys: readonly string[];
}

// Settings S4 — the gate's narrow rejection (a separate reason so the
// caller can distinguish a policy-precondition failure from the D5
// integrity failure).
export interface S4GateDetails {
  reason: 'financials_audit_not_enabled';
  role_key: 'auditor_with_financials';
}
