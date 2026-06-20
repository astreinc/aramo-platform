// Settings Rebuild Directive 5 — roles-catalog shapes + canonical role
// presentation metadata.
//
// The catalog is the SINGLE SOURCE for the FE roles surfaces (the RolePicker +
// the read-only Roles & permissions matrix), closing the hand-mirror drift.
// The scope BUNDLES (the matrix data) and the description come from the live DB
// (Role + RoleScope, seeded) — never a hand list. The only metadata not in the
// schema is presentation tier + the S4 settings-gate; that lives here, in the
// backend, validated for completeness by a smoke spec.

export interface RoleCatalogScopeGate {
  // The role's grant is gated by a tenant KNOWN_SETTING that must be `true`
  // (Settings S4 — auditor_with_financials needs audit.financials_enabled).
  readonly setting_key: 'audit.financials_enabled';
  readonly disabled_message: string;
}

export interface RoleCatalogView {
  readonly key: string;
  readonly display: string;
  readonly description: string;
  readonly tier: string;
  // The scope keys this role carries (sorted, deduped) — the matrix data.
  readonly scopes: readonly string[];
  readonly requires_setting?: RoleCatalogScopeGate;
}

// Canonical per-role presentation metadata (tier + the S4 gate). Keyed by role
// key. The DB Role is the source for key/description/scopes; this supplies only
// what the schema doesn't carry. A smoke spec asserts every tenant role has an
// entry (completeness — no silent drift). Tier RANK orders the catalog.
interface RoleMeta {
  readonly tier: string;
  readonly tierRank: number;
  readonly requiresSetting?: RoleCatalogScopeGate;
}

export const ROLE_CATALOG_META: Record<string, RoleMeta> = {
  tenant_owner: { tier: 'Administration', tierRank: 0 },
  tenant_admin: { tier: 'Administration', tierRank: 0 },
  delivery_manager: { tier: 'Management', tierRank: 1 },
  account_manager: { tier: 'Management', tierRank: 1 },
  recruiting_manager: { tier: 'Management', tierRank: 1 },
  lead_recruiter: { tier: 'Management', tierRank: 1 },
  sourcer: { tier: 'Operations', tierRank: 2 },
  recruiter: { tier: 'Operations', tierRank: 2 },
  back_office: { tier: 'Operations', tierRank: 2 },
  finance: { tier: 'Finance & compliance', tierRank: 3 },
  auditor: { tier: 'Finance & compliance', tierRank: 3 },
  auditor_with_financials: {
    tier: 'Finance & compliance',
    tierRank: 3,
    requiresSetting: {
      setting_key: 'audit.financials_enabled',
      disabled_message:
        'Enable "Financial-auditor grant" in Settings before assigning this role.',
    },
  },
  candidate: { tier: 'Portal', tierRank: 4 },
};

// The display name = the role description's leading phrase (the seed writes
// every description as "Display Name — explanation"). Falls back to a humanized
// key if the description is missing or unshaped.
export function displayFromDescription(
  description: string | null,
  key: string,
): string {
  if (description) {
    const lead = description.split('—')[0]?.trim();
    if (lead && lead.length > 0) return lead;
  }
  return key
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function metaRank(key: string): number {
  return ROLE_CATALOG_META[key]?.tierRank ?? 99;
}
