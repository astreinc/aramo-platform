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
  readonly relationship: readonly CompanyFacetBucket[]; // status
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
  readonly status?: readonly string[]; // relationship
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
