import type { CompanyView } from './company.view.js';

// Phase 2 — the native server-side faceted-search contract for companies
// (single-schema; mirrors libs/talent-record's TalentSearchQuery/Page). Filter +
// sort + KEYSET cursor pagination + facet COUNTS run inside libs/company against
// Company columns ONLY. The D4b visibility predicate is applied alongside (id IN
// visible_client_ids) exactly as listForActor does.
//
// Facet counts + `total` are computed over the BASE where (tenant + site + q +
// owner scope + visibility) — independent of the relationship/tier/industry/flag
// SELECTIONS — so the facet-rail counts and the segment badges stay stable as
// the operator toggles filters. The page `items` are narrowed by the full
// selection set. (This is a deliberate simplification vs talent's
// per-selection-narrowed facets — companies have a small, capped working set.)

export type CompanySortKey = 'name' | 'created_at' | 'last_activity';
export type SortDir = 'asc' | 'desc';

export interface CompanyFacetBucket {
  readonly value: string;
  readonly count: number;
}

export interface CompanyFacets {
  // Company Party/Role (ADR-0032, VR5) — the fake `relationship` facet (which
  // was a groupBy on the retiring Company.status) is replaced by the REAL
  // relationship dimensions over CompanyRelationship: type buckets back the
  // Client/Vendor/Partner tabs; status buckets back the in-tab lifecycle pills.
  readonly relationship_type: readonly CompanyFacetBucket[]; // CLIENT|VENDOR|PARTNER
  readonly relationship_status: readonly CompanyFacetBucket[]; // PROSPECT|ACTIVE|ON_HOLD|INACTIVE
  readonly tier: readonly CompanyFacetBucket[]; // client_tier
  readonly industry: readonly CompanyFacetBucket[];
  readonly hot: number;
  readonly off_limits: number;
  readonly exclusivity: number;
  readonly quiet: number; // last_activity_at older than QUIET_DAYS, or never
}

export interface CompanySearchQuery {
  readonly tenant_id: string;
  readonly site_id?: string;
  // filters (all native, single-schema)
  readonly q?: string; // name ILIKE
  readonly owner_id?: string; // scope=mine → the actor's own accounts
  // Company Party/Role (ADR-0032, VR5/Amendment 6) — relationship-specific
  // filtering over CompanyRelationship. relationship_type = the tab
  // (Clients/Vendors/Partners); relationship_status = the in-tab lifecycle
  // pills. A company matches when it has ≥1 relationship satisfying BOTH
  // (some-relationship semantics): `Clients + Active` = a CLIENT relationship
  // that is ACTIVE; `All + Active` = any relationship that is ACTIVE.
  readonly relationship_type?: readonly string[];
  readonly relationship_status?: readonly string[];
  readonly client_tier?: readonly string[];
  readonly industry?: readonly string[];
  readonly is_hot?: boolean;
  readonly off_limits?: boolean;
  readonly exclusivity?: boolean;
  readonly quiet?: boolean; // quiet 30d+ segment
  // sort + keyset cursor
  readonly sort?: CompanySortKey;
  readonly dir?: SortDir;
  readonly cursor?: string; // opaque (last row id, base64url)
  readonly page_size?: number;
}

export interface CompanySearchPage {
  readonly items: readonly CompanyView[];
  readonly next_cursor: string | null;
  readonly facets: CompanyFacets;
  // Full-set count over the base where (scope + q) — the "of M" in "N of M".
  readonly total: number;
}

// Quiet threshold — kept in sync with the FE company-workspace QUIET_DAYS.
export const QUIET_DAYS = 30;
