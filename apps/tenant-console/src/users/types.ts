// Settings S5b — hand-mirrored types for the tenant user-management surface.
//
// Mirror sources (NO @aramo/* import — apps/tenant-console stays a leaf
// consumer of the HTTP surface; the FE-isolation rule from S5a):
//   - TenantUserView: libs/identity/src/lib/identity.repository.ts
//   - TENANT_ASSIGNABLE_ROLES: libs/identity/prisma/seed.ts
//
// Ruling 2 (Gate-5): hand-mirror + a smoke spec is the chosen posture —
// types.spec.ts enumerates the 13 expected keys so a catalog change
// fails a test, not silently diverges. A GET-roles-catalog backend
// endpoint is a possible future follow-up if churn picks up; not now.
//
// Ruling 5 (Gate-5): `candidate` IS included. The picker mirrors the
// catalog. If candidate-in-staff-mgmt looks wrong, that surfaces a
// catalog-placement question — the FE does not silently filter the
// catalog.

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

// ─── The tenant-tier assignable role catalog (the picker's source) ────
//
// The 13 keys mirror libs/identity/prisma/seed.ts. `super_admin` is
// platform-only and intentionally excluded; every other catalog role is
// assignable from this surface.
//
// Each entry's `label` is the operator-facing role name (R10 vocab);
// `description` is the one-liner shown under the label in the picker.
// `helper` is a per-role note surfaced WHEN the role is selectable but
// has a precondition (Settings S4 gate for auditor_with_financials).
//
// `requiresSetting` ties the role to a settings-key precondition. The
// picker reads that setting to enable/disable the option proactively
// (ruling 4: try-read + graceful 403 fallback). The BE rejection is the
// source of truth; this is a courtesy.

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

export const TENANT_ASSIGNABLE_ROLES: readonly TenantRoleCatalogEntry[] =
  Object.freeze([
    {
      key: 'tenant_owner',
      label: 'Tenant Owner',
      description: 'Full tenant authority; see-all compensation.',
    },
    {
      key: 'tenant_admin',
      label: 'Tenant Admin',
      description: 'Tenant administration; see-all compensation.',
    },
    {
      key: 'delivery_manager',
      label: 'Delivery Manager',
      description: 'Manages delivery teams and assignments.',
    },
    {
      key: 'account_manager',
      label: 'Account Manager',
      description: 'Owns client accounts; sees bill markup.',
    },
    {
      key: 'recruiting_manager',
      label: 'Recruiting Manager',
      description: 'Leads a recruiting team.',
    },
    {
      key: 'lead_recruiter',
      label: 'Lead Recruiter',
      description: 'Senior recruiter responsibilities.',
    },
    {
      key: 'sourcer',
      label: 'Sourcer',
      description: 'Sources candidates; no compensation visibility.',
    },
    {
      key: 'recruiter',
      label: 'Recruiter',
      description: 'Standard recruiter; sees rate spread.',
    },
    {
      key: 'finance',
      label: 'Finance',
      description: 'Sees bill markup; not pay rates.',
    },
    {
      key: 'auditor',
      label: 'Auditor',
      description: 'Read-only audit access; no compensation visibility.',
    },
    {
      key: 'back_office',
      label: 'Back Office',
      description: 'Operations and back-office tasks.',
    },
    {
      key: 'candidate',
      label: 'Candidate',
      description: 'Portal-side persona; included per catalog (ruling 5).',
    },
    {
      key: 'auditor_with_financials',
      label: 'Auditor with Financials',
      description: 'Audit access including see-all compensation.',
      helper:
        'Requires "Financial-auditor grant" enabled in Settings.',
      requiresSetting: {
        key: 'audit.financials_enabled',
        disabledMessage:
          'Enable "Financial-auditor grant" in Settings before assigning this role.',
      },
    },
  ]);

export const TENANT_ASSIGNABLE_ROLE_KEYS: readonly string[] = Object.freeze(
  TENANT_ASSIGNABLE_ROLES.map((r) => r.key),
);

// Lookup helper — undefined for an unknown key (e.g. a future catalog
// addition the mirror does not yet know about). The smoke spec keeps
// this set in sync with the seed.
export function findRoleEntry(
  key: string,
): TenantRoleCatalogEntry | undefined {
  return TENANT_ASSIGNABLE_ROLES.find((r) => r.key === key);
}

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
